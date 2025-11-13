"use strict";
// ============================================
// FILE: src/pythonEnvironment.ts
// WHAT IT DOES: Manages Python environment detection via Python extension API
// ============================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.PythonEnvironmentManager = void 0;
const vscode = require("vscode");
const python_extension_1 = require("@vscode/python-extension");
const child_process_1 = require("child_process");
class PythonEnvironmentManager {
    constructor() {
        this.available = false;
        this.changeListeners = [];
    }
    /**
     * Initialize connection to Python extension API
     */
    async initialize() {
        try {
            this.pythonApi = await python_extension_1.PythonExtension.api();
            this.available = true;
            // Listen for environment changes
            try {
                if (this.pythonApi.environments &&
                    typeof this.pythonApi.environments.onDidChangeActiveEnvironmentPath === 'function') {
                    this.pythonApi.environments.onDidChangeActiveEnvironmentPath((e) => {
                        console.log('[Bardic] Python active environment path changed:', e);
                        this.notifyListeners();
                    });
                    console.log('[Bardic] Successfully registered for Python environment change events');
                }
                else {
                    console.warn('[Bardic] onDidChangeActiveEnvironmentPath not found - will not auto-refresh on env changes');
                }
            }
            catch (eventError) {
                console.warn('[Bardic] Could not register Python environment change listener:', eventError);
            }
            // Debug: Log available API
            console.log('[Bardic] Python API structure:', {
                hasEnvironments: !!this.pythonApi.environments,
                environmentsType: typeof this.pythonApi.environments,
                environmentsMethods: this.pythonApi.environments ?
                    Object.getOwnPropertyNames(Object.getPrototypeOf(this.pythonApi.environments)) : [],
                apiKeys: Object.keys(this.pythonApi)
            });
            console.log('[Bardic] Python extension integration initialized');
        }
        catch (error) {
            this.available = false;
            // Don't throw - just mark as unavailable (graceful degradation)
            console.warn('[Bardic] Python extension not available:', error);
        }
    }
    /**
     * Check if Python extension is available
     */
    isPythonExtensionAvailable() {
        return this.available;
    }
    /**
     * Get current Python executable path
     */
    async getPythonPath(workspaceUri) {
        if (!this.available) {
            return undefined;
        }
        try {
            const envPath = this.pythonApi.environments.getActiveEnvironmentPath(workspaceUri);
            const environment = await this.pythonApi.environments.resolveEnvironment(envPath);
            return environment?.executable.uri.fsPath;
        }
        catch (error) {
            console.error('[Bardic] Error getting Python path:', error);
            return undefined;
        }
    }
    /**
     * Check if bardic is installed in the given Python environment
     */
    async isBardicInstalled(pythonPath) {
        return new Promise((resolve) => {
            console.log('[Bardic] Checking if bardic installed in:', pythonPath);
            // Use the full CLI path that we know works
            const process = (0, child_process_1.spawn)(pythonPath, ['-m', 'bardic.cli.main', '--version']);
            let hasOutput = false;
            let stdout = '';
            let stderr = '';
            process.stdout.on('data', (data) => {
                hasOutput = true;
                stdout += data.toString();
            });
            process.stderr.on('data', (data) => {
                // Some Python versions output --version to stderr
                stderr += data.toString();
                hasOutput = true;
            });
            process.on('close', (code) => {
                console.log('[Bardic] Bardic check result:', {
                    pythonPath,
                    exitCode: code,
                    hasOutput,
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                });
                resolve(code === 0 && hasOutput);
            });
            process.on('error', (err) => {
                console.log('[Bardic] Bardic check error:', err);
                resolve(false);
            });
            // Timeout after 2 seconds
            setTimeout(() => {
                console.log('[Bardic] Bardic check timeout');
                process.kill();
                resolve(false);
            }, 2000);
        });
    }
    /**
     * Get detailed environment information
     */
    async getEnvironmentInfo(pythonPath) {
        const info = {
            path: pythonPath,
            hasBardic: false
        };
        // Check if bardic is installed
        info.hasBardic = await this.isBardicInstalled(pythonPath);
        // Get bardic version if installed
        if (info.hasBardic) {
            info.bardicVersion = await this.getBardicVersion(pythonPath);
        }
        // Try to get Python version
        try {
            const version = await this.getPythonVersion(pythonPath);
            info.version = version;
        }
        catch {
            // Version detection failed - not critical
        }
        return info;
    }
    /**
     * Listen for environment changes
     */
    onEnvironmentChanged(callback) {
        this.changeListeners.push(callback);
        return new vscode.Disposable(() => {
            const index = this.changeListeners.indexOf(callback);
            if (index >= 0) {
                this.changeListeners.splice(index, 1);
            }
        });
    }
    notifyListeners() {
        this.changeListeners.forEach(listener => {
            try {
                listener();
            }
            catch (error) {
                console.error('[Bardic] Error in environment change listener:', error);
            }
        });
    }
    async getPythonVersion(pythonPath) {
        return new Promise((resolve) => {
            const process = (0, child_process_1.spawn)(pythonPath, ['--version']);
            let output = '';
            process.stdout.on('data', (data) => {
                output += data.toString();
            });
            process.stderr.on('data', (data) => {
                output += data.toString();
            });
            process.on('close', (code) => {
                if (code === 0 && output) {
                    // Extract version from "Python 3.11.0"
                    const match = /Python\s+([\d.]+)/.exec(output);
                    resolve(match ? match[1] : undefined);
                }
                else {
                    resolve(undefined);
                }
            });
            process.on('error', () => {
                resolve(undefined);
            });
            setTimeout(() => {
                process.kill();
                resolve(undefined);
            }, 2000);
        });
    }
    async getBardicVersion(pythonPath) {
        return new Promise((resolve) => {
            const process = (0, child_process_1.spawn)(pythonPath, ['-m', 'bardic', '--version']);
            let output = '';
            process.stdout.on('data', (data) => {
                output += data.toString();
            });
            process.stderr.on('data', (data) => {
                output += data.toString();
            });
            process.on('close', (code) => {
                if (code === 0 && output) {
                    // Extract version from output
                    const match = /([\d.]+)/.exec(output.trim());
                    resolve(match ? match[1] : 'unknown');
                }
                else {
                    resolve(undefined);
                }
            });
            process.on('error', () => {
                resolve(undefined);
            });
            setTimeout(() => {
                process.kill();
                resolve(undefined);
            }, 2000);
        });
    }
}
exports.PythonEnvironmentManager = PythonEnvironmentManager;
//# sourceMappingURL=pythonEnvironment.js.map