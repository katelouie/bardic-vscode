"use strict";
/**
 * Folding range provider for Bardic passages.
 * Allows folding from :: PassageName to the line before the next ::.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BardFoldingProvider = void 0;
const vscode = require("vscode");
class BardFoldingProvider {
    provideFoldingRanges(document, context, token) {
        const ranges = [];
        const text = document.getText();
        const lines = text.split('\n');
        let currentPassageStart;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // Check if this is a passage header: :: PassageName
            if (/^::/.test(line)) {
                // Close previous passage if exists
                if (currentPassageStart !== undefined && i > currentPassageStart + 1) {
                    ranges.push(new vscode.FoldingRange(currentPassageStart, i - 1, vscode.FoldingRangeKind.Region));
                }
                // Start new passage
                currentPassageStart = i;
            }
        }
        // Close final passage
        if (currentPassageStart !== undefined && lines.length > currentPassageStart + 1) {
            ranges.push(new vscode.FoldingRange(currentPassageStart, lines.length - 1, vscode.FoldingRangeKind.Region));
        }
        return ranges;
    }
}
exports.BardFoldingProvider = BardFoldingProvider;
//# sourceMappingURL=foldingProvider.js.map