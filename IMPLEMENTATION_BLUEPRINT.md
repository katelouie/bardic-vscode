# Bardic VSCode Extension: Python Integration & Live Preview
## Comprehensive Implementation Blueprint

**Created:** November 9, 2025
**Author:** Kate + Claude
**Status:** Planning Phase
**Estimated Total Implementation Time:** 6-8 hours across 3 sessions

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Feature 1: Python Environment Integration](#feature-1-python-environment-integration)
3. [Feature 2: Live Preview Panel](#feature-2-live-preview-panel)
4. [Architecture Overview](#architecture-overview)
5. [Edge Cases & Error Handling](#edge-cases--error-handling)
6. [Testing Strategy](#testing-strategy)
7. [User Experience Flows](#user-experience-flows)
8. [Future Enhancements](#future-enhancements)
9. [Open Questions & Design Decisions](#open-questions--design-decisions)

---

## Executive Summary

### Vision

Enable Bardic extension to:
1. **Leverage Python environments** - Use VSCode's Python extension API to detect and use the user's selected Python interpreter
2. **Robust graph compilation** - Call `bardic compile` CLI to generate accurate story graphs from compiled JSON
3. **Live passage preview** - Render individual passages with the Bardic engine, allowing writers to test-drive their stories without leaving VSCode

### Core Principles

- **Graceful degradation** - Features work progressively (CLI → simple parser fallback)
- **Zero configuration** - Works out of box if Python extension + bardic installed
- **Extensible architecture** - Easy to enhance later (state presets, advanced preview controls)
- **Familiar UX** - Follows VSCode conventions and existing extension patterns

### Success Metrics

- Graph generation works for 100% of valid .bard files (vs ~95% with simple parser)
- Preview panel shows rendered passage in <500ms
- Zero crashes from Python environment issues
- Clear error messages guide users to solutions

---

## Feature 1: Python Environment Integration

### Goals

1. Detect user's active Python interpreter via Python extension API
2. Execute `python -m bardic.cli.main compile` using that interpreter
3. Parse compiled JSON for robust graph generation
4. Fall back to simple parser if CLI unavailable
5. Handle all edge cases gracefully

### Architecture

#### Component: PythonEnvironmentManager

**File:** `src/pythonEnvironment.ts`

**Responsibilities:**
- Interface with Python extension API
- Track active interpreter changes
- Provide Python path to other components
- Handle Python extension not installed

**Public API:**
```typescript
class PythonEnvironmentManager {
    // Initialize connection to Python extension
    async initialize(): Promise<void>

    // Get current Python executable path
    async getPythonPath(workspaceUri?: vscode.Uri): Promise<string | undefined>

    // Check if Python extension is available
    isPythonExtensionAvailable(): boolean

    // Check if bardic is installed in environment
    async isBardicInstalled(pythonPath: string): Promise<boolean>

    // Listen for interpreter changes
    onEnvironmentChanged(callback: () => void): vscode.Disposable

    // Get environment details for display/debugging
    async getEnvironmentInfo(pythonPath: string): Promise<EnvironmentInfo>
}

interface EnvironmentInfo {
    path: string;
    version?: string;
    type?: 'system' | 'venv' | 'conda' | 'pyenv';
    hasBardic: boolean;
    bardicVersion?: string;
}
```

**Implementation Details:**

1. **Initialization:**
   ```typescript
   async initialize() {
       try {
           this.pythonApi = await PythonExtension.api();
           this.available = true;

           // Listen for environment changes
           this.pythonApi.environments.onDidChangeActiveEnvironment(() => {
               this.emit('environmentChanged');
           });
       } catch (error) {
           this.available = false;
           // Don't throw - just mark as unavailable
           console.warn('Python extension not available:', error);
       }
   }
   ```

2. **Getting Python Path:**
   ```typescript
   async getPythonPath(workspaceUri?: vscode.Uri): Promise<string | undefined> {
       if (!this.available) return undefined;

       const envPath = this.pythonApi.environments.getActiveEnvironmentPath(workspaceUri);
       const environment = await this.pythonApi.environments.resolveEnvironment(envPath);

       return environment?.executable.uri.fsPath;
   }
   ```

3. **Checking Bardic Installation:**
   ```typescript
   async isBardicInstalled(pythonPath: string): Promise<boolean> {
       return new Promise((resolve) => {
           const process = spawn(pythonPath, ['-m', 'bardic', '--version']);
           let hasOutput = false;

           process.stdout.on('data', () => { hasOutput = true; });
           process.on('close', (code) => {
               resolve(code === 0 && hasOutput);
           });

           // Timeout after 2 seconds
           setTimeout(() => {
               process.kill();
               resolve(false);
           }, 2000);
       });
   }
   ```

#### Component: BardCompiler

**File:** `src/compiler.ts`

**Responsibilities:**
- Compile .bard files using CLI or simple parser
- Parse CLI output JSON
- Provide unified interface for both compilation methods
- Handle compilation errors gracefully

**Public API:**
```typescript
class BardCompiler {
    constructor(private pythonManager: PythonEnvironmentManager)

    // Compile using best available method
    async compile(filePath: string): Promise<CompilationResult>

    // Force specific compilation method (for testing)
    async compileWithCLI(filePath: string, pythonPath: string): Promise<CompilationResult>
    async compileWithSimpleParser(content: string): Promise<CompilationResult>
}

interface CompilationResult {
    success: boolean;
    data?: CompiledStory;  // Graph data format
    error?: CompilationError;
    method: 'cli' | 'simple-parser';
    warnings?: string[];
}

interface CompilationError {
    type: 'python-not-found' | 'bardic-not-installed' | 'syntax-error' | 'unknown';
    message: string;
    hint?: string;  // User-friendly suggestion
    lineNumber?: number;
    filePath?: string;
}

interface CompiledStory {
    nodes: GraphNode[];
    edges: GraphEdge[];
    startPassage: string;
    missingPassages: string[];
    orphanPassages: string[];
    passages: Record<string, PassageData>;
}
```

**Implementation Details:**

1. **Smart Compilation Strategy:**
   ```typescript
   async compile(filePath: string): Promise<CompilationResult> {
       // Try CLI first if available
       const pythonPath = await this.pythonManager.getPythonPath();

       if (pythonPath) {
           const hasBardic = await this.pythonManager.isBardicInstalled(pythonPath);

           if (hasBardic) {
               const result = await this.compileWithCLI(filePath, pythonPath);
               if (result.success) {
                   return result;
               }
               // CLI failed - fall through to simple parser
               console.warn('CLI compilation failed, falling back to simple parser');
           }
       }

       // Fallback to simple parser
       const content = await fs.promises.readFile(filePath, 'utf-8');
       return this.compileWithSimpleParser(content);
   }
   ```

2. **CLI Compilation:**
   ```typescript
   async compileWithCLI(filePath: string, pythonPath: string): Promise<CompilationResult> {
       return new Promise((resolve) => {
           const tempOutput = path.join(os.tmpdir(), `bardic-${Date.now()}.json`);

           const process = spawn(pythonPath, [
               '-m', 'bardic.cli.main',
               'compile',
               filePath,
               '-o', tempOutput
           ]);

           let stderr = '';
           process.stderr.on('data', (data) => { stderr += data.toString(); });

           process.on('close', async (code) => {
               if (code === 0) {
                   try {
                       const json = await fs.promises.readFile(tempOutput, 'utf-8');
                       const storyData = JSON.parse(json);
                       const graphData = this.convertToGraphFormat(storyData);

                       // Clean up temp file
                       await fs.promises.unlink(tempOutput).catch(() => {});

                       resolve({
                           success: true,
                           data: graphData,
                           method: 'cli'
                       });
                   } catch (error) {
                       resolve({
                           success: false,
                           error: {
                               type: 'unknown',
                               message: `Failed to parse CLI output: ${error.message}`
                           },
                           method: 'cli'
                       });
                   }
               } else {
                   // Parse stderr for helpful error messages
                   const error = this.parseBardError(stderr);
                   resolve({
                       success: false,
                       error,
                       method: 'cli'
                   });
               }
           });

           // Timeout after 10 seconds
           setTimeout(() => {
               process.kill();
               resolve({
                   success: false,
                   error: {
                       type: 'unknown',
                       message: 'Compilation timeout (10s)'
                   },
                   method: 'cli'
               });
           }, 10000);
       });
   }
   ```

3. **Error Parsing:**
   ```typescript
   private parseBardError(stderr: string): CompilationError {
       // Example bardic error format:
       // Error in test.bard:42: SyntaxError: Unclosed conditional

       const lineMatch = /Error in (.+?):(\d+): (.+)/.exec(stderr);
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
           message: stderr || 'Unknown compilation error'
       };
   }
   ```

4. **Convert CLI JSON to Graph Format:**
   ```typescript
   private convertToGraphFormat(storyData: any): CompiledStory {
       // CLI outputs JSON with passages, start_passage, etc.
       // Need to convert to graph node/edge format

       const nodes: GraphNode[] = [];
       const edges: GraphEdge[] = [];
       const passages = storyData.passages || {};
       const startPassage = storyData.start_passage || Object.keys(passages)[0];

       const referencedPassages = new Set<string>();
       const allTargets = new Set<string>();

       // Build nodes and edges
       Object.keys(passages).forEach(passageName => {
           const passage = passages[passageName];

           // Extract choices to find targets
           const choices = passage.choices || [];
           choices.forEach((choice: any) => {
               const target = choice.target;
               allTargets.add(target);

               if (passages[target]) {
                   referencedPassages.add(target);
               }

               edges.push({
                   from: passageName,
                   to: target,
                   label: choice.text,
                   isConditional: !!choice.condition,
                   isJump: choice.type === 'jump'
               });
           });

           // Check if passage has parameters
           const hasParams = /\(.+\)/.test(passage.name || passageName);

           nodes.push({
               id: passageName,
               label: passage.name || passageName,
               hasParams,
               isMissing: false,
               isOrphan: !referencedPassages.has(passageName) && passageName !== startPassage
           });
       });

       // Find missing passages
       const missingPassages = Array.from(allTargets).filter(
           target => !passages[target]
       );

       missingPassages.forEach(passageName => {
           nodes.push({
               id: passageName,
               label: passageName + '\n🚨 MISSING',
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
           passages
       };
   }
   ```

#### Integration with GraphPanel

**Modifications to `src/graphPanel.ts`:**

1. **Accept pre-compiled data:**
   ```typescript
   class BardGraphPanel {
       // Change constructor signature
       private constructor(
           panel: vscode.WebviewPanel,
           extensionUri: vscode.Uri,
           compilationResult: CompilationResult,
           filePath: string
       ) {
           // ...
           this._update(compilationResult);
       }

       private _update(compilationResult: CompilationResult) {
           if (compilationResult.success && compilationResult.data) {
               // Use pre-compiled data
               this._panel.webview.html = this._getHtmlForWebview(compilationResult.data);
           } else {
               // Show error
               this._panel.webview.html = this._getErrorHtml(compilationResult.error);
           }
       }
   }
   ```

2. **Keep simple parser as method:**
   ```typescript
   // Keep existing _simpleParse() unchanged
   // Just don't call it directly anymore
   ```

#### Extension.ts Integration

**Modifications to `src/extension.ts`:**

```typescript
export async function activate(context: vscode.ExtensionContext) {
    // Initialize Python environment manager
    const pythonManager = new PythonEnvironmentManager();
    await pythonManager.initialize();

    // Initialize compiler
    const compiler = new BardCompiler(pythonManager);

    // Show Graph command
    let showGraph = vscode.commands.registerCommand('bardic.showGraph', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'bard') {
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

            if (result.success) {
                // Show graph with compiled data
                BardGraphPanel.createOrShow(context.extensionUri, result, filePath);

                // Show method used
                if (result.method === 'simple-parser') {
                    vscode.window.showWarningMessage(
                        'Graph generated using simple parser. Install bardic in your Python environment for more accurate results.',
                        'Learn More'
                    ).then(selection => {
                        if (selection === 'Learn More') {
                            vscode.env.openExternal(vscode.Uri.parse('https://github.com/yourusername/bardic#installation'));
                        }
                    });
                }
            } else {
                // Show error with helpful hint
                const message = result.error?.hint
                    ? `${result.error.message}\n\n${result.error.hint}`
                    : result.error?.message || 'Unknown error';

                vscode.window.showErrorMessage(message);
            }
        });
    });

    // Listen for Python environment changes
    pythonManager.onEnvironmentChanged(() => {
        // Refresh graph if visible
        BardGraphPanel.updateIfVisible();
    });

    // Auto-update graph on save
    vscode.workspace.onDidSaveTextDocument(async document => {
        if (document.languageId === 'bard' && BardGraphPanel.currentPanel) {
            const result = await compiler.compile(document.uri.fsPath);
            BardGraphPanel.updateWithData(result);
        }
    });

    context.subscriptions.push(showGraph);
}
```

### Edge Cases & Error Handling

#### 1. Python Extension Not Installed

**Problem:** User doesn't have Python extension installed
**Detection:** `PythonExtension.api()` throws error
**Handling:**
- PythonEnvironmentManager marks itself as unavailable
- Compiler falls back to simple parser immediately
- No error shown to user (graceful degradation)
- Optional: Show info message first time suggesting Python extension

#### 2. Python Extension Installed, No Interpreter Selected

**Problem:** Python extension present but no interpreter chosen
**Detection:** `getPythonPath()` returns undefined
**Handling:**
- Show helpful message: "No Python interpreter selected. Using simple parser for graph generation."
- Provide action button: "Select Python Interpreter" → opens Python extension's picker
- Fall back to simple parser

#### 3. Python Interpreter Selected, Bardic Not Installed

**Problem:** Valid Python env but no bardic package
**Detection:** `isBardicInstalled()` returns false
**Handling:**
- Show warning: "Bardic not installed in selected environment. Using simple parser."
- Provide action button: "Install Bardic" → opens terminal with `pip install bardic`
- Fall back to simple parser

#### 4. Bardic Installed, Compilation Fails

**Problem:** Syntax error in .bard file
**Detection:** CLI returns non-zero exit code
**Handling:**
- Parse stderr for error details (line number, error message)
- Show error notification with location
- Provide "Go to Line" action button
- Try simple parser as last resort (may also fail, but different error)

#### 5. CLI Timeout

**Problem:** Compilation takes >10 seconds (very large file)
**Detection:** Timeout timer fires
**Handling:**
- Kill Python process
- Show warning: "Compilation timeout. File may be too large."
- Fall back to simple parser
- Consider: Allow user to increase timeout in settings

#### 6. Multi-Root Workspace

**Problem:** Multiple workspace folders with different Python envs
**Detection:** `vscode.workspace.workspaceFolders.length > 1`
**Handling:**
- Pass workspace URI to `getPythonPath(workspaceUri)`
- Use the Python environment associated with the .bard file's workspace
- Show which environment is being used in output channel

#### 7. Workspace vs Global Python Settings

**Problem:** Workspace has different Python than global
**Detection:** Python extension handles this
**Handling:**
- Trust Python extension's `getActiveEnvironmentPath(workspaceUri)`
- No special handling needed

#### 8. Virtual Environment Activated in Terminal but Not in Extension

**Problem:** User has venv activated in terminal but VSCode not aware
**Detection:** Python extension should handle this, but might not
**Handling:**
- Document in README: "Select interpreter via Python extension, not just terminal"
- Show current Python path in output channel for debugging
- Respect Python extension's selection

#### 9. Bardic Import Errors (Missing Dependencies)

**Problem:** Bardic installed but missing dependencies
**Detection:** CLI stderr contains ImportError
**Handling:**
- Parse error message
- Suggest: "Try reinstalling bardic: pip install --upgrade bardic"
- Fall back to simple parser

#### 10. File Path with Spaces or Special Characters

**Problem:** File path contains spaces/unicode
**Detection:** Path parsing
**Handling:**
- Properly quote file paths in spawn() arguments
- Use Node's path.normalize() and proper escaping
- Test with paths like: `/path/with spaces/файл.bard`

### Testing Strategy

#### Unit Tests

**PythonEnvironmentManager:**
- Mock Python extension API
- Test initialization with/without extension
- Test environment change callbacks
- Test bardic detection

**BardCompiler:**
- Mock spawn() calls
- Test CLI success path
- Test CLI error paths
- Test simple parser fallback
- Test timeout handling
- Test JSON parsing

#### Integration Tests

1. **Happy Path:**
   - Python extension installed
   - Interpreter selected
   - Bardic installed
   - Valid .bard file
   - → Graph shows with CLI data

2. **Degradation Path:**
   - No Python extension
   - → Graph shows with simple parser

3. **Error Path:**
   - Syntax error in .bard file
   - → Error shown with line number

#### Manual Testing Checklist

- [ ] Extension activates without Python extension
- [ ] Extension works with Python extension + no interpreter
- [ ] Extension works with interpreter + no bardic
- [ ] Extension works with bardic installed
- [ ] Graph refreshes on environment change
- [ ] Graph refreshes on file save
- [ ] Error messages are helpful
- [ ] Large files (>10k lines) compile or timeout gracefully
- [ ] Files with Unicode characters work
- [ ] Multi-root workspaces work
- [ ] Virtual environments work
- [ ] Conda environments work

### Package.json Changes

```json
{
  "name": "bardic",
  "version": "0.5.0",
  "extensionDependencies": [
    "ms-python.python"
  ],
  "dependencies": {
    "@vscode/python-extension": "^1.0.5"
  },
  "activationEvents": [
    "onLanguage:bard"
  ],
  "contributes": {
    "configuration": {
      "title": "Bardic",
      "properties": {
        "bardic.compilationTimeout": {
          "type": "number",
          "default": 10000,
          "description": "Timeout for CLI compilation in milliseconds"
        },
        "bardic.preferCLI": {
          "type": "boolean",
          "default": true,
          "description": "Prefer CLI compilation over simple parser when available"
        }
      }
    }
  }
}
```

---

## Feature 2: Live Preview Panel

### Goals

1. Preview individual passages rendered with Bardic engine
2. Allow users to provide state variable values
3. Navigate through story via choice buttons
4. Update preview on file save
5. Right-click passage header to preview
6. Minimal, clean UI matching graph aesthetic

### Architecture

#### Component: PreviewPanel

**File:** `src/previewPanel.ts`

**Responsibilities:**
- Manage webview lifecycle
- Render passage content with Bardic engine
- Handle choice navigation
- Manage state variables
- Update on file saves

**Public API:**
```typescript
class PreviewPanel {
    static currentPanel: PreviewPanel | undefined;

    // Create or show preview for a passage
    static async createOrShow(
        extensionUri: vscode.Uri,
        passageName: string,
        storyData: CompiledStory,
        initialState?: Record<string, any>
    ): Promise<void>

    // Update preview content
    async updatePassage(passageName: string, state: Record<string, any>): Promise<void>

    // Navigate to different passage (via choice)
    async navigateToPassage(passageName: string, args?: any[]): Promise<void>

    // Update when file changes
    static async updateIfVisible(storyData: CompiledStory): Promise<void>

    dispose(): void
}
```

**State Management:**

```typescript
interface PreviewState {
    currentPassage: string;
    globalState: Record<string, any>;  // Game state variables
    history: PassageHistoryEntry[];     // Navigation history
    storyData: CompiledStory;           // Compiled story JSON
}

interface PassageHistoryEntry {
    passageName: string;
    state: Record<string, any>;
    timestamp: number;
}
```

**Implementation Approach:**

**Question:** Should we run Python engine or implement JS renderer?

**Option A: Python Subprocess Engine**

*Pros:*
- 100% accurate rendering (uses actual Bardic engine)
- Supports all Python features (@py blocks, imports, etc.)
- No reimplementation needed

*Cons:*
- Complex IPC (Inter-Process Communication)
- Slower (spawn process for each render)
- Harder to debug
- State serialization challenges (custom objects)
- Requires bardic installed

*Implementation:*
```typescript
async renderPassage(passageName: string, state: any): Promise<RenderResult> {
    // Spawn: python -m bardic.runtime.engine
    // Send via stdin: JSON with story data, current passage, state
    // Receive via stdout: Rendered passage JSON
    // Parse and display
}
```

**Option B: JavaScript Engine Implementation**

*Pros:*
- Fast (no process spawn)
- Easy debugging
- Works without bardic installed
- Can enhance with browser-only features (live search, etc.)

*Cons:*
- Need to reimplement core engine logic
- Python @py blocks won't work (or need sandboxed eval)
- Maintaining parity with Python engine
- More code to write/maintain

*Implementation:*
```typescript
class BardEngineJS {
    // Implement subset of Python engine in TypeScript
    renderPassage(passage: PassageData, state: any): RenderedPassage
    evaluateExpression(expr: string, context: any): any
    processConditional(condition: string, context: any): boolean
    filterChoices(choices: Choice[], state: any): Choice[]
}
```

**RECOMMENDATION: Start with Option B (JS Engine)**

*Rationale:*
1. Simpler to implement and debug
2. Works without Python/bardic (better UX)
3. Faster rendering
4. Can add Python subprocess later as "accurate mode" option
5. Most common use case (previewing text/choices) doesn't need full Python

*Scope:*
- Render basic passage text
- Evaluate simple expressions (`{variable}`, `{health - 10}`)
- Support inline conditionals (`{hp > 0 ? Alive | Dead}`)
- Filter conditional choices
- Support passage parameters
- **Exclude for now:** @py blocks, imports, complex Python expressions

*Future Enhancement:*
- Add "Accurate Preview" option that uses Python subprocess
- Show warning: "Preview uses simplified renderer. Some features (@py blocks) not supported."

#### Component: StateManager

**File:** `src/stateManager.ts`

**Responsibilities:**
- Detect required variables from passage content
- Prompt user for variable values
- Parse and validate input
- Persist state across previews (optional)
- Provide defaults for common variables

**Public API:**
```typescript
class StateManager {
    // Collect variables referenced in passage
    collectRequiredVariables(passage: PassageData): VariableInfo[]

    // Prompt user for variable values
    async promptForVariables(variables: VariableInfo[]): Promise<Record<string, any>>

    // Parse input string to appropriate type
    parseValue(input: string, expectedType?: 'number' | 'string' | 'boolean'): any

    // Load persisted state for file
    loadState(fileUri: vscode.Uri): Record<string, any>

    // Save state for file
    saveState(fileUri: vscode.Uri, state: Record<string, any>): void
}

interface VariableInfo {
    name: string;
    inferredType?: 'number' | 'string' | 'boolean' | 'object';
    usageContext: string;  // Where it appears in passage
    defaultValue?: any;
}
```

**Variable Detection:**

```typescript
collectRequiredVariables(passage: PassageData): VariableInfo[] {
    const variables = new Set<string>();
    const content = passage.content || '';

    // Find {variable} expressions
    const expressionRegex = /\{([^}]+)\}/g;
    let match;

    while ((match = expressionRegex.exec(content)) !== null) {
        const expr = match[1];

        // Extract variable names (skip _state, _local)
        const varNames = this.extractVariableNames(expr);
        varNames.forEach(v => {
            if (v !== '_state' && v !== '_local') {
                variables.add(v);
            }
        });
    }

    // Find @if conditionals
    const ifRegex = /@if\s+(.+?):/g;
    while ((match = ifRegex.exec(content)) !== null) {
        const condition = match[1];
        const varNames = this.extractVariableNames(condition);
        varNames.forEach(v => variables.add(v));
    }

    // Convert to VariableInfo array with type inference
    return Array.from(variables).map(name => ({
        name,
        inferredType: this.inferType(name, content),
        usageContext: this.getUsageContext(name, content)
    }));
}

private extractVariableNames(expression: string): string[] {
    // Simple approach: split on operators and filter for identifiers
    // More robust: Use a proper expression parser
    const tokens = expression.split(/[\s+\-*\/()[\].,<>=!&|?:]/);
    return tokens.filter(t => /^[a-zA-Z_]\w*$/.test(t));
}

private inferType(varName: string, content: string): 'number' | 'string' | 'boolean' | 'object' {
    // Look at usage context to infer type

    // Numeric context: {hp - 10}, {gold > 50}
    if (/\{[^}]*\b${varName}\b[^}]*[+\-*\/]\s*\d+/.test(content)) {
        return 'number';
    }

    // Boolean context: @if has_key:
    if (new RegExp(`@if\\s+${varName}:`).test(content)) {
        return 'boolean';
    }

    // Object context: {item.name}, {player['level']}
    if (new RegExp(`${varName}\\.(\\w+)|${varName}\\[`).test(content)) {
        return 'object';
    }

    // Default to string
    return 'string';
}
```

**User Input Prompting:**

```typescript
async promptForVariables(variables: VariableInfo[]): Promise<Record<string, any>> {
    const state: Record<string, any> = {};

    for (const varInfo of variables) {
        const value = await this.promptForValue(varInfo);
        if (value !== undefined) {
            state[varInfo.name] = value;
        }
    }

    return state;
}

private async promptForValue(varInfo: VariableInfo): Promise<any> {
    const defaultValue = this.getDefaultForType(varInfo.inferredType);

    const input = await vscode.window.showInputBox({
        prompt: `Enter value for "${varInfo.name}"`,
        placeHolder: `${varInfo.inferredType} (used in: ${varInfo.usageContext})`,
        value: String(defaultValue),
        validateInput: (value) => {
            return this.validateInput(value, varInfo.inferredType);
        }
    });

    if (input === undefined) return undefined;  // User cancelled

    return this.parseValue(input, varInfo.inferredType);
}

parseValue(input: string, expectedType?: string): any {
    if (!input) return null;

    // Try parsing as JSON first (handles objects, arrays, booleans, nulls)
    try {
        return JSON.parse(input);
    } catch {
        // Not valid JSON, continue
    }

    // Type-specific parsing
    switch (expectedType) {
        case 'number':
            const num = Number(input);
            return isNaN(num) ? 0 : num;

        case 'boolean':
            return input.toLowerCase() === 'true' || input === '1';

        case 'object':
            // Try to parse as Python dict-like syntax
            // e.g., "{'name': 'Sword', 'damage': 10}"
            try {
                // Convert Python dict to JSON
                const jsonified = input
                    .replace(/'/g, '"')
                    .replace(/True/g, 'true')
                    .replace(/False/g, 'false')
                    .replace(/None/g, 'null');
                return JSON.parse(jsonified);
            } catch {
                return {};  // Fallback to empty object
            }

        default:
            return input;  // Return as string
    }
}

private validateInput(value: string, type?: string): string | undefined {
    if (!value) return undefined;  // Empty is okay

    switch (type) {
        case 'number':
            if (isNaN(Number(value))) {
                return 'Must be a valid number';
            }
            break;

        case 'boolean':
            if (!['true', 'false', '1', '0'].includes(value.toLowerCase())) {
                return 'Must be true, false, 1, or 0';
            }
            break;

        case 'object':
            try {
                JSON.parse(value.replace(/'/g, '"'));
            } catch {
                return 'Must be valid JSON or Python dict syntax';
            }
            break;
    }

    return undefined;  // Valid
}
```

**State Persistence:**

```typescript
// Store state per file in workspace state or global state
private stateStorage = new Map<string, Record<string, any>>();

saveState(fileUri: vscode.Uri, state: Record<string, any>): void {
    const key = fileUri.toString();
    this.stateStorage.set(key, state);

    // Optionally persist to disk via ExtensionContext.globalState
    // this.context.globalState.update(key, state);
}

loadState(fileUri: vscode.Uri): Record<string, any> {
    const key = fileUri.toString();
    return this.stateStorage.get(key) || {};
}
```

#### Component: PassageDetector

**File:** `src/passageDetector.ts`

**Responsibilities:**
- Find passage at cursor position
- Extract passage name
- Determine passage boundaries

**Public API:**
```typescript
class PassageDetector {
    // Find passage containing cursor position
    findPassageAtPosition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): PassageInfo | undefined

    // Get all passages in document
    getAllPassages(document: vscode.TextDocument): PassageInfo[]
}

interface PassageInfo {
    name: string;           // Passage name
    fullName: string;       // Name with parameters: "Shop(item)"
    startLine: number;      // Line where :: PassageName appears
    endLine: number;        // Line before next :: or EOF
    hasParameters: boolean;
    parameters: string[];   // Extracted param names
}
```

**Implementation:**

```typescript
findPassageAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): PassageInfo | undefined {
    const allPassages = this.getAllPassages(document);

    // Find passage containing cursor
    return allPassages.find(p =>
        position.line >= p.startLine && position.line <= p.endLine
    );
}

getAllPassages(document: vscode.TextDocument): PassageInfo[] {
    const passages: PassageInfo[] = [];
    const text = document.getText();
    const lines = text.split('\n');

    let currentPassage: Partial<PassageInfo> | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Check for passage header
        const passageMatch = /^::\s+([\w.]+)(\(([^)]*)\))?/.exec(line);

        if (passageMatch) {
            // Save previous passage
            if (currentPassage) {
                currentPassage.endLine = i - 1;
                passages.push(currentPassage as PassageInfo);
            }

            // Start new passage
            const baseName = passageMatch[1];
            const params = passageMatch[3] || '';
            const fullName = baseName + (passageMatch[2] || '');

            currentPassage = {
                name: baseName,
                fullName,
                startLine: i,
                hasParameters: !!params,
                parameters: params ? params.split(',').map(p => p.trim().split('=')[0]) : []
            };
        }
    }

    // Close last passage
    if (currentPassage) {
        currentPassage.endLine = lines.length - 1;
        passages.push(currentPassage as PassageInfo);
    }

    return passages;
}
```

#### Webview Implementation

**HTML Structure:**

```html
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            background: #1a0033;
            color: #f4e4c1;
            font-family: Georgia, serif;
            padding: 20px;
            margin: 0;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
        }

        .passage-header {
            border-bottom: 2px solid #d4af37;
            padding-bottom: 10px;
            margin-bottom: 20px;
        }

        .passage-name {
            font-size: 24px;
            font-weight: bold;
            color: #d4af37;
        }

        .passage-content {
            line-height: 1.8;
            margin-bottom: 30px;
        }

        .choices {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .choice {
            background: rgba(45, 27, 78, 0.85);
            border: 1px solid rgba(212, 175, 55, 0.5);
            padding: 12px 16px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .choice:hover {
            background: rgba(45, 27, 78, 0.95);
            border-color: rgba(212, 175, 55, 0.8);
            transform: translateX(5px);
        }

        .state-panel {
            position: fixed;
            top: 10px;
            right: 10px;
            background: rgba(26, 0, 51, 0.85);
            border: 1px solid rgba(212, 175, 55, 0.5);
            padding: 10px;
            border-radius: 4px;
            font-size: 11px;
            max-width: 200px;
            backdrop-filter: blur(4px);
        }

        .state-title {
            font-weight: bold;
            color: #d4af37;
            margin-bottom: 5px;
        }

        .state-var {
            margin: 3px 0;
            font-family: monospace;
        }

        .navigation {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid rgba(212, 175, 55, 0.3);
            display: flex;
            gap: 10px;
        }

        .nav-button {
            background: rgba(26, 0, 51, 0.85);
            border: 1px solid rgba(212, 175, 55, 0.5);
            padding: 6px 12px;
            border-radius: 3px;
            color: #d4af37;
            cursor: pointer;
            font-size: 10px;
        }

        .nav-button:hover {
            background: rgba(45, 27, 78, 0.95);
        }

        .error {
            background: rgba(74, 0, 0, 0.5);
            border: 1px solid #ff4444;
            padding: 15px;
            border-radius: 4px;
            color: #ffcccc;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="passage-header">
            <div class="passage-name" id="passage-name"></div>
        </div>

        <div class="passage-content" id="passage-content"></div>

        <div class="choices" id="choices"></div>

        <div class="navigation">
            <button class="nav-button" onclick="goBack()">← Back</button>
            <button class="nav-button" onclick="reset()">⟳ Reset</button>
            <button class="nav-button" onclick="editState()">⚙ Edit State</button>
        </div>
    </div>

    <div class="state-panel">
        <div class="state-title">State</div>
        <div id="state-vars"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // Render passage data
        function render(data) {
            document.getElementById('passage-name').textContent = data.passageName;
            document.getElementById('passage-content').innerHTML = data.content;

            // Render choices
            const choicesEl = document.getElementById('choices');
            choicesEl.innerHTML = '';

            data.choices.forEach((choice, index) => {
                const btn = document.createElement('div');
                btn.className = 'choice';
                btn.textContent = choice.text;
                btn.onclick = () => selectChoice(index);
                choicesEl.appendChild(btn);
            });

            // Render state
            const stateEl = document.getElementById('state-vars');
            stateEl.innerHTML = '';

            Object.entries(data.state).forEach(([key, value]) => {
                const varEl = document.createElement('div');
                varEl.className = 'state-var';
                varEl.textContent = `${key}: ${JSON.stringify(value)}`;
                stateEl.appendChild(varEl);
            });
        }

        function selectChoice(index) {
            vscode.postMessage({
                command: 'choiceSelected',
                index: index
            });
        }

        function goBack() {
            vscode.postMessage({ command: 'goBack' });
        }

        function reset() {
            vscode.postMessage({ command: 'reset' });
        }

        function editState() {
            vscode.postMessage({ command: 'editState' });
        }

        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.command) {
                case 'render':
                    render(message.data);
                    break;
                case 'error':
                    showError(message.error);
                    break;
            }
        });

        function showError(error) {
            const container = document.querySelector('.container');
            container.innerHTML = `
                <div class="error">
                    <strong>Error:</strong> ${error.message}
                    ${error.hint ? `<br><br><em>${error.hint}</em>` : ''}
                </div>
            `;
        }
    </script>
</body>
</html>
```

#### Extension Commands

**Add to package.json:**

```json
{
  "contributes": {
    "commands": [
      {
        "command": "bardic.previewPassage",
        "title": "Preview Passage",
        "category": "Bardic"
      }
    ],
    "menus": {
      "editor/context": [
        {
          "when": "resourceLangId == bard",
          "command": "bardic.previewPassage",
          "group": "bardic"
        }
      ]
    }
  }
}
```

**Implementation in extension.ts:**

```typescript
let previewPassage = vscode.commands.registerCommand('bardic.previewPassage', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'bard') {
        vscode.window.showErrorMessage('Not a .bard file');
        return;
    }

    // Find passage at cursor
    const passageInfo = passageDetector.findPassageAtPosition(
        editor.document,
        editor.selection.active
    );

    if (!passageInfo) {
        vscode.window.showErrorMessage('Cursor not inside a passage');
        return;
    }

    // Compile the story
    const filePath = editor.document.uri.fsPath;
    const compilationResult = await compiler.compile(filePath);

    if (!compilationResult.success) {
        vscode.window.showErrorMessage(`Compilation failed: ${compilationResult.error?.message}`);
        return;
    }

    // Detect required variables
    const passage = compilationResult.data.passages[passageInfo.name];
    const requiredVars = stateManager.collectRequiredVariables(passage);

    // Load previous state or prompt for new
    let state = stateManager.loadState(editor.document.uri);

    if (Object.keys(state).length === 0 && requiredVars.length > 0) {
        // First time - prompt for variables
        state = await stateManager.promptForVariables(requiredVars);
    }

    // Show preview
    PreviewPanel.createOrShow(
        context.extensionUri,
        passageInfo.name,
        compilationResult.data,
        state
    );
});
```

### Edge Cases & Error Handling

#### 1. Passage Parameters

**Problem:** Preview passage requires arguments (e.g., `:: Shop(item)`)
**Detection:** `passageInfo.hasParameters` is true
**Handling:**
- Prompt for parameter values: "This passage requires parameter 'item'. Enter value:"
- Store as local variables in `_local`
- Show in state panel with `[local]` indicator

#### 2. Missing Variables During Render

**Problem:** Passage references variable not in state
**Detection:** Variable used but not in `state` dict
**Handling:**
- Show error in preview: "Missing variable: 'gold'"
- Offer "Add Variable" button → prompts for value
- Use default of 0/""/false based on usage context

#### 3. Python Expressions in Text

**Problem:** Passage contains `@py` blocks or complex Python
**Detection:** Content contains `@py:` or `@endpy`
**Handling:**
- Show warning banner: "⚠ This passage contains Python code. Preview may not be accurate."
- Render the @py block as placeholder: `[Python code block]`
- Suggest using "Test in Terminal" or full game preview

#### 4. Object Attribute Access

**Problem:** `{player.name}` where player is object
**Detection:** Expression contains `.` operator
**Handling:**
- Require state to have nested structure: `{player: {name: "Hero"}}`
- Prompt with example: "Enter value for 'player' as JSON: {'name': 'Hero', 'hp': 100}"
- Evaluate using safe property access

#### 5. Conditional Choices Not Showing

**Problem:** All choices filtered out by conditions
**Detection:** `filteredChoices.length === 0`
**Handling:**
- Show message: "No choices available with current state"
- Show "Edit State" button prominently
- List failed conditions: "Choice 'Fight' requires: hp > 0 (current: 0)"

#### 6. Circular Navigation

**Problem:** Choice leads back to same passage
**Detection:** `target === currentPassage`
**Handling:**
- Allow it (valid game design)
- Show history to prevent confusion
- "Back" button works correctly

#### 7. File Changes While Preview Open

**Problem:** User edits .bard file while preview is open
**Detection:** `onDidSaveTextDocument` event
**Handling:**
- Automatically recompile and refresh preview
- Maintain current state
- Show notification: "Preview refreshed"
- If compilation fails, show error without closing preview

#### 8. Missing Passage Target

**Problem:** Choice points to passage that doesn't exist
**Detection:** `compilationResult.missingPassages` contains target
**Handling:**
- Show choice as disabled/grayed out
- Tooltip: "Target passage 'BadTarget' not found"
- Allow clicking → show error message

#### 9. Large State Objects

**Problem:** State contains huge objects/arrays
**Detection:** `JSON.stringify(state).length > 10000`
**Handling:**
- Truncate state display in panel
- Show "..." for large values
- Provide "View Full State" button → opens JSON in new editor

#### 10. Invalid User Input

**Problem:** User enters invalid value for variable
**Detection:** Validation function in showInputBox
**Handling:**
- Show inline error message
- Don't accept input until valid
- Provide examples in placeholder

### Testing Strategy

#### Unit Tests

**StateManager:**
- Test variable detection
- Test type inference
- Test value parsing
- Test validation

**PassageDetector:**
- Test finding passage at position
- Test passage boundaries
- Test parameter extraction

**JS Engine (if implemented):**
- Test expression evaluation
- Test conditional evaluation
- Test choice filtering

#### Integration Tests

1. **Basic Preview:**
   - Open .bard file
   - Right-click passage
   - Preview shows content and choices

2. **State Prompting:**
   - Preview passage with variables
   - Prompted for values
   - Values persist across previews

3. **Choice Navigation:**
   - Click choice
   - Navigates to target passage
   - State updates correctly

4. **File Update:**
   - Edit passage while preview open
   - Save file
   - Preview refreshes automatically

#### Manual Testing Checklist

- [ ] Preview simple passage (no variables)
- [ ] Preview passage with variables
- [ ] Preview passage with parameters
- [ ] Navigate via choices
- [ ] Navigate to passage with parameters
- [ ] Back button works
- [ ] Reset button works
- [ ] Edit state button works
- [ ] State persists between previews
- [ ] Preview refreshes on file save
- [ ] Error shown for missing variables
- [ ] Error shown for syntax errors
- [ ] Conditional choices filter correctly
- [ ] Inline conditionals render
- [ ] Large passages render
- [ ] Unicode content works

---

## Architecture Overview

### Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Extension Host                        │
│  ┌────────────────────────────────────────────────────┐ │
│  │              extension.ts                          │ │
│  │  - activate()                                      │ │
│  │  - register commands                               │ │
│  │  - coordinate components                           │ │
│  └────────────────────────────────────────────────────┘ │
│                          │                               │
│          ┌───────────────┼───────────────┐              │
│          │               │               │              │
│  ┌───────▼───────┐ ┌────▼────────┐ ┌───▼──────────┐   │
│  │ Python Env    │ │ Bard        │ │ Preview      │   │
│  │ Manager       │ │ Compiler    │ │ Panel        │   │
│  └───────┬───────┘ └────┬────────┘ └───┬──────────┘   │
│          │               │               │              │
│  ┌───────▼───────────────▼───────────────▼──────────┐  │
│  │          Python Extension API                    │  │
│  │  @vscode/python-extension                        │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
           │                       │
           │                       │
    ┌──────▼──────┐         ┌──────▼──────┐
    │  Python     │         │  Webview    │
    │  Process    │         │  (Graph/    │
    │  (bardic)   │         │   Preview)  │
    └─────────────┘         └─────────────┘
```

### Data Flow

**Graph Generation Flow:**
```
.bard file
    │
    ▼
BardCompiler.compile()
    │
    ├─→ Try CLI compilation
    │   └─→ spawn python -m bardic.cli.main compile
    │       └─→ Parse JSON output
    │           └─→ Convert to graph format
    │
    └─→ Fallback to simple parser
        └─→ Regex-based parsing
            └─→ Generate graph data
    │
    ▼
GraphPanel.createOrShow(compilationResult)
    │
    ▼
Webview displays graph
```

**Preview Flow:**
```
User right-clicks passage
    │
    ▼
PassageDetector.findPassageAtPosition()
    │
    ▼
BardCompiler.compile(file)
    │
    ▼
StateManager.detectRequiredVariables()
    │
    ▼
StateManager.promptForVariables()
    │
    ▼
PreviewPanel.createOrShow(passage, state)
    │
    ├─→ JS Engine renders passage
    │   └─→ Evaluate expressions
    │       └─→ Filter choices
    │           └─→ Return rendered HTML
    │
    └─→ Send to webview
        │
        ▼
    Webview displays passage
        │
        ▼
    User clicks choice
        │
        ▼
    Message back to extension
        │
        ▼
    Navigate to new passage
        │
        ▼
    Re-render with updated state
```

### File Structure

```
bardic-vscode/
├── src/
│   ├── extension.ts           # Entry point, command registration
│   ├── pythonEnvironment.ts   # Python extension integration
│   ├── compiler.ts            # CLI and simple parser wrapper
│   ├── graphPanel.ts          # Graph webview (modified)
│   ├── previewPanel.ts        # Preview webview (new)
│   ├── stateManager.ts        # State variable handling (new)
│   ├── passageDetector.ts     # Find passage at cursor (new)
│   └── jsEngine.ts            # Optional: JS-based renderer (new)
├── package.json               # Extension manifest
├── tsconfig.json
└── README.md
```

---

## Edge Cases & Error Handling

### Comprehensive Error Matrix

| Scenario | Detection | User Experience | Recovery |
|----------|-----------|-----------------|----------|
| Python ext not installed | `PythonExtension.api()` throws | Silent fallback to simple parser | Install Python ext suggested in README |
| No interpreter selected | `getPythonPath()` → undefined | Info notification on first graph | "Select Interpreter" button |
| Bardic not installed | `isBardicInstalled()` → false | Warning on graph with "Install" button | `pip install bardic` in terminal |
| Syntax error in .bard | CLI stderr | Error notification with line number | "Go to Line" button |
| Compilation timeout | Timer expires | Warning notification | Increase timeout in settings |
| Missing variables in preview | Variable undefined during render | Error in preview + "Add Variable" | Prompt for value |
| Invalid user input | Validation function | Inline error in input box | Examples in placeholder |
| Choice target missing | Target not in passages dict | Disabled choice with tooltip | Fix .bard file |
| Circular navigation | target === currentPassage | Allow (valid design) | History tracks correctly |
| File changes during preview | onDidSaveTextDocument | Auto-refresh preview | Maintain state |
| Large state (>10KB) | `JSON.stringify().length` | Truncate display | "View Full State" |
| Unicode in file path | Path handling | Proper escaping | Works transparently |
| Multi-root workspace | Multiple workspace folders | Use workspace-specific Python env | Python ext handles |
| @py blocks in preview | Content contains `@py:` | Warning banner | Suggest full testing |

---

## Testing Strategy

### Test Pyramid

```
         ╱╲
        ╱  ╲      E2E Tests (5%)
       ╱────╲     - Full workflows in VSCode
      ╱      ╲
     ╱────────╲   Integration Tests (15%)
    ╱          ╲  - Component interactions
   ╱────────────╲
  ╱              ╲ Unit Tests (80%)
 ╱────────────────╲ - Individual functions
```

### Unit Test Coverage

**PythonEnvironmentManager:**
- ✅ Initialize with Python ext available
- ✅ Initialize without Python ext
- ✅ Get Python path
- ✅ Check bardic installation
- ✅ Environment change callbacks

**BardCompiler:**
- ✅ Compile with CLI success
- ✅ Compile with CLI failure (syntax error)
- ✅ Compile with CLI timeout
- ✅ Compile with simple parser
- ✅ Convert JSON to graph format
- ✅ Parse error messages
- ✅ Handle missing passages
- ✅ Handle orphan passages

**StateManager:**
- ✅ Detect variables in simple passage
- ✅ Detect variables in complex expressions
- ✅ Infer types correctly
- ✅ Parse number inputs
- ✅ Parse boolean inputs
- ✅ Parse object inputs (JSON)
- ✅ Validate inputs
- ✅ Persist state
- ✅ Load state

**PassageDetector:**
- ✅ Find passage at cursor
- ✅ Find all passages
- ✅ Extract passage names
- ✅ Extract parameters
- ✅ Calculate boundaries

**JS Engine (if implemented):**
- ✅ Render simple text
- ✅ Evaluate {variable}
- ✅ Evaluate {expr + expr}
- ✅ Evaluate inline conditionals
- ✅ Filter conditional choices
- ✅ Handle passage parameters

### Integration Tests

**Feature 1 (Python + Graph):**
1. Extension activates without Python ext → graph uses simple parser
2. Python ext installed, no interpreter → warning shown
3. Interpreter selected, no bardic → simple parser with warning
4. Bardic installed → graph uses CLI
5. Environment change → graph refreshes
6. File save → graph updates
7. Syntax error → error shown with line number

**Feature 2 (Preview):**
1. Right-click passage → preview opens
2. Passage with variables → prompted for values
3. Click choice → navigates correctly
4. Back button → returns to previous
5. Reset → goes to start
6. Edit state → can modify variables
7. File save → preview refreshes
8. Conditional choice → filters correctly

### Manual Test Plan

**Setup Tests:**
- [ ] Install extension in clean VSCode
- [ ] Install extension with Python ext already present
- [ ] Install extension with bardic already in env

**Graph Tests:**
- [ ] Open .bard file, show graph
- [ ] Graph shows correct structure
- [ ] Click node → jumps to passage
- [ ] Missing passages show in red
- [ ] Orphan passages show in cyan
- [ ] Parameterized passages show in green
- [ ] Export PNG works
- [ ] Export SVG works
- [ ] Stats show correct counts
- [ ] Legend displays correctly

**Python Integration Tests:**
- [ ] Switch Python environment → graph refreshes
- [ ] Deactivate Python ext → graph still works
- [ ] Install bardic in env → graph switches to CLI
- [ ] Uninstall bardic → graph switches to simple parser
- [ ] File with syntax error → error shown
- [ ] Large file (>1000 passages) compiles

**Preview Tests:**
- [ ] Right-click passage → preview opens
- [ ] Preview shows passage content
- [ ] Preview shows choices
- [ ] Click choice → navigates
- [ ] Back button works
- [ ] Reset button works
- [ ] State panel shows variables
- [ ] Edit state button works
- [ ] Passage with parameters → prompts for args
- [ ] Conditional choice filters
- [ ] Missing variable → error shown
- [ ] File save → preview updates

---

## User Experience Flows

### Flow 1: First-Time User (No Python Extension)

```
User installs Bardic extension
    │
    ▼
Opens .bard file
    │
    ▼
Clicks "Show Graph"
    │
    ▼
Graph opens using simple parser
    │
    ▼
[No warnings - works transparently]
```

**Design Decision:** Don't force Python extension on users who just want basic graph functionality.

### Flow 2: User with Python Extension, No Bardic

```
User has Python extension installed
    │
    ▼
Opens .bard file, clicks "Show Graph"
    │
    ▼
Extension checks for bardic in env
    │
    ▼
Not found → Shows info notification:
  "Bardic not installed in Python environment.
   Using simplified graph generation.
   For best results: pip install bardic"
   [Install Now] [Don't Show Again]
    │
    ▼
Graph opens with simple parser
```

**Design Decision:** Be helpful but not pushy. User can opt out of notifications.

### Flow 3: User with Bardic Installed

```
User has bardic installed
    │
    ▼
Opens .bard file, clicks "Show Graph"
    │
    ▼
Extension compiles with CLI
    │
    ▼
Graph opens with full accuracy
    │
    ▼
[No notifications - everything just works]
```

**Design Decision:** Silent success is best UX.

### Flow 4: Preview Passage for First Time

```
User editing passage with variables
    │
    ▼
Right-clicks passage header
    │
    ▼
Selects "Preview Passage"
    │
    ▼
Extension detects required variables:
  - hp
  - gold
  - has_sword
    │
    ▼
Shows input prompts:
  "Enter value for 'hp' (number): [100]"
  "Enter value for 'gold' (number): [50]"
  "Enter value for 'has_sword' (boolean): [true]"
    │
    ▼
User provides values
    │
    ▼
Preview opens showing rendered passage
    │
    ▼
User clicks choice
    │
    ▼
Navigates to next passage
    │
    ▼
State persists (no re-prompting)
```

**Design Decision:** Only prompt once per session. Store state for quick iteration.

### Flow 5: Syntax Error in File

```
User editing .bard file
    │
    ▼
Introduces syntax error (unclosed conditional)
    │
    ▼
Saves file
    │
    ▼
Clicks "Show Graph"
    │
    ▼
CLI compilation fails with error:
  "Error in story.bard:42: SyntaxError: Unclosed @if block"
    │
    ▼
Shows error notification:
  [!] Compilation Error
  Unclosed @if block at line 42
  [Go to Line] [Dismiss]
    │
    ▼
User clicks "Go to Line"
    │
    ▼
Editor jumps to line 42, highlights error
```

**Design Decision:** Make errors actionable. Don't just say "error" - help fix it.

---

## Future Enhancements

### Phase 1 Extensions (After Initial Release)

1. **State Presets**
   - Save/load named state configurations
   - E.g., "Test Combat (hp=10, enemy=boss)"
   - Quick switching between test scenarios

2. **Advanced State Editor**
   - Replace input prompts with rich webview form
   - Type-aware inputs (sliders for numbers, checkboxes for booleans)
   - Save preset button
   - Import/export JSON

3. **Passage Parameter Helper**
   - Auto-detect passage signature from header
   - Validate calls against signature
   - Suggest argument values based on usage

4. **Python Subprocess Engine Option**
   - "Accurate Preview" mode using Python engine
   - Toggle in settings: `bardic.previewEngine: "js" | "python"`
   - Supports @py blocks and imports

5. **Story Testing Tools**
   - "Test All Passages" command
   - Checks for unreachable passages
   - Validates all variable references
   - Reports missing passages
   - Coverage map (which passages visited in testing)

6. **Graph Enhancements**
   - Show passage parameters in node labels
   - Show argument values on edges when known
   - Filter graph (show only reachable from X)
   - Highlight critical path
   - Show variable mutations on edges

### Phase 2 Extensions (Long-term)

1. **Collaborative Features**
   - Share state presets via GitHub gists
   - Export walkthrough as markdown
   - Story analytics (which paths taken most)

2. **Advanced Preview**
   - Side-by-side code + preview
   - Inline preview on hover
   - Multi-passage preview (show tree of outcomes)

3. **Story Linting**
   - Detect common mistakes (orphaned passages, missing vars)
   - Style suggestions (passage length, choice count)
   - Accessibility checks (color contrast, reading level)

4. **Integration with bardic serve**
   - Launch full story server from VSCode
   - Hot-reload on save
   - Debug mode with step-through

5. **Story Templates**
   - Snippets for common patterns (shop, combat, dialogue)
   - Scaffold new stories from templates
   - Import community templates

---

## Open Questions & Design Decisions

### ✅ Resolved

1. **Use Python Extension API?**
   - ✅ YES - Leverage @vscode/python-extension for environment detection

2. **CLI vs Simple Parser Priority?**
   - ✅ Always prefer CLI if available, silent fallback to simple parser

3. **Preview Pane Location?**
   - ✅ Webview panel in ViewColumn.Two (like graph)

4. **State Input UX?**
   - ✅ Start with simple input prompts, design for extensibility

5. **JS Engine vs Python Subprocess?**
   - ✅ Start with JS engine for simplicity, Python subprocess as future enhancement

### ❓ Open Questions

1. **Should we implement @py block support in JS engine?**
   - Option A: Skip @py blocks, show warning
   - Option B: Use sandboxed eval (risky)
   - Option C: Always require Python for passages with @py
   - **Recommendation:** Option A for v1, Option C as future enhancement

2. **How to handle imports in preview?**
   - Example: `from bardic_stdlib.inventory import Inventory`
   - Option A: Mock common stdlib modules in JS
   - Option B: Require Python subprocess for imports
   - Option C: Show error, suggest full testing
   - **Recommendation:** Option C, provide helpful error message

3. **Should state persist between sessions (after VSCode restart)?**
   - Option A: Yes, save to workspace state
   - Option B: Yes, save to global state
   - Option C: No, always start fresh
   - **Recommendation:** Option B (global state) with "Clear All States" command

4. **Show preview automatically on passage hover?**
   - Pros: Quick feedback, no clicking needed
   - Cons: Might be distracting, requires state already set
   - **Recommendation:** No for v1, consider as experimental feature

5. **Support multi-passage preview (show outcome tree)?**
   - Example: Show "if you pick A → passage X → choices Y, Z"
   - Pros: Great for planning, understanding flow
   - Cons: Complex UI, exponential growth
   - **Recommendation:** Future enhancement, start simple

6. **Integrate with version control (show diffs in preview)?**
   - Example: "This passage changed: old vs new"
   - Pros: Useful for reviewing changes
   - Cons: Complex, narrow use case
   - **Recommendation:** Not in scope for initial release

### 🎯 Design Principles to Follow

1. **Progressive Enhancement**
   - Works without any dependencies
   - Gets better with Python extension
   - Gets even better with bardic installed
   - Never blocks basic functionality

2. **Clear Error Messages**
   - Always explain what went wrong
   - Always suggest how to fix it
   - Provide actionable buttons when possible
   - Link to docs/help when needed

3. **Performance First**
   - Don't block UI thread
   - Show progress for slow operations
   - Cache compilation results
   - Debounce file watchers

4. **Familiar Patterns**
   - Match VSCode UX conventions
   - Use standard notification styles
   - Follow extension best practices
   - Consistent with existing features

5. **Future-Proof Architecture**
   - Design for extensibility
   - Clean abstractions
   - Pluggable components
   - Easy to add features without refactoring

---

## Implementation Timeline

### Session 1: Python Integration (2-3 hours)

**Goals:**
- Set up Python extension dependency
- Implement PythonEnvironmentManager
- Implement BardCompiler with CLI support
- Update GraphPanel to accept compiled data
- Test all error paths

**Deliverables:**
- Graph works with CLI compilation
- Graceful fallback to simple parser
- All edge cases handled
- Tests passing

### Session 2: Preview Foundation (2-3 hours)

**Goals:**
- Implement PreviewPanel
- Implement StateManager
- Implement PassageDetector
- Create basic webview UI
- Register commands

**Deliverables:**
- Can preview simple passages
- State prompting works
- Context menu integration
- Basic navigation (no complex features)

### Session 3: Preview Polish (2-3 hours)

**Goals:**
- Implement JS engine for rendering
- Add choice navigation
- Add state persistence
- Add live updates on file save
- Polish UI and error handling

**Deliverables:**
- Full preview functionality
- All test cases passing
- Documentation updated
- Ready to publish

---

## Success Criteria

### Feature 1: Python Integration

✅ **Must Have:**
- Graph compiles using CLI when available
- Falls back to simple parser when CLI unavailable
- No errors when Python extension not installed
- Clear messaging about compilation method
- File saves trigger re-compilation

✅ **Should Have:**
- Environment changes trigger re-compilation
- Syntax errors show line numbers
- Timeout handling for large files
- Performance similar or better than simple parser

🎁 **Nice to Have:**
- Show compilation method in output channel
- Detailed logs for debugging
- Settings for timeout and preferences

### Feature 2: Live Preview

✅ **Must Have:**
- Preview simple passages with text and choices
- Navigate via choice buttons
- Prompt for required variables
- State persists between previews
- Updates on file save

✅ **Should Have:**
- Context menu integration
- Command palette integration
- Back/reset navigation
- Edit state functionality
- Conditional choice filtering

🎁 **Nice to Have:**
- State presets
- Rich state editor
- Multi-passage view
- History navigation

---

## Risk Assessment

### High Risk

1. **Python subprocess stability**
   - *Risk:* Process hangs, crashes, or leaks
   - *Mitigation:* Timeout handling, process cleanup, fallback to simple parser

2. **State serialization complexity**
   - *Risk:* Custom objects don't serialize/deserialize
   - *Mitigation:* Start with JSON-serializable types only, document limitations

3. **Performance with large files**
   - *Risk:* Compilation takes too long, UI freezes
   - *Mitigation:* Progress indicators, timeouts, caching

### Medium Risk

1. **Breaking changes in Python extension API**
   - *Risk:* API changes break integration
   - *Mitigation:* Pin to stable version, test with different versions

2. **Expression evaluation edge cases**
   - *Risk:* JS engine doesn't match Python semantics
   - *Mitigation:* Comprehensive test suite, fallback suggestions

3. **Unicode/encoding issues**
   - *Risk:* Non-ASCII characters break compilation
   - *Mitigation:* Proper encoding handling, test with various languages

### Low Risk

1. **VSCode API changes**
   - *Risk:* Extension API changes
   - *Mitigation:* Target stable API versions, automated tests

2. **User confusion**
   - *Risk:* Too many options, unclear errors
   - *Mitigation:* Progressive disclosure, clear documentation

---

## Conclusion

This blueprint provides a comprehensive plan for implementing both Python integration and live preview features in the Bardic VSCode extension. The architecture is designed for:

- **Robustness** - Graceful degradation at every level
- **Extensibility** - Easy to add features without refactoring
- **User Experience** - Clear, helpful, and unobtrusive
- **Maintainability** - Clean abstractions and thorough testing

The implementation is scoped into three manageable sessions, each building on the previous one. All major edge cases have been considered, and mitigation strategies are in place.

**Ready to build!** 🦝✨

---

*Blueprint created with love by Kate & Claude*
*November 9, 2025*
