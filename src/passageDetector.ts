/**
 * Detects passages in .bard files and finds passage at cursor position.
 */

import * as vscode from 'vscode';

export interface PassageInfo {
    name: string;           // Passage name without parameters
    fullName: string;       // Name with parameters: "Shop(item)"
    startLine: number;      // Line where :: PassageName appears
    endLine: number;        // Line before next :: or EOF
    hasParameters: boolean;
    parameters: string[];   // Extracted param names
}

export class PassageDetector {
    /**
     * Find passage containing the cursor position.
     */
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

    /**
     * Get all passages in document.
     */
    getAllPassages(document: vscode.TextDocument): PassageInfo[] {
        const passages: PassageInfo[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        let currentPassage: Partial<PassageInfo> | null = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Check for passage header: :: PassageName or :: PassageName(params)
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
                    parameters: params
                        ? params.split(',').map(p => p.trim().split('=')[0].trim())
                        : []
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

    /**
     * Get passage by name.
     */
    getPassageByName(
        document: vscode.TextDocument,
        passageName: string
    ): PassageInfo | undefined {
        const allPassages = this.getAllPassages(document);
        return allPassages.find(p => p.name === passageName);
    }
}
