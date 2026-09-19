import type { CompilerOptions } from 'typescript';

export type AnalysisSide = 'base' | 'head';

export type SymbolKind =
  | 'module'
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable';

export interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SymbolRecord {
  id: string;
  side: AnalysisSide;
  file: string;
  name: string;
  kind: SymbolKind;
  comparisonKey: string;
  range: SourceRange;
  exported: boolean;
  publicContractChanged: boolean;
  typeText?: string;
  parentId?: string;
}

export interface ChangedLine {
  file: string;
  side: AnalysisSide;
  line: number;
  changeType: 'added' | 'deleted';
  symbolId?: string;
}

export interface ChangedSymbol {
  symbolId: string;
  side: AnalysisSide;
  file: string;
  changedRanges: SourceRange[];
  changeType: 'added' | 'modified' | 'deleted';
  exported: boolean;
  publicContractChanged: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'IMPORTS' | 'EXPORTS' | 'CALLS';
  confidence: number;
  resolver: 'typescript';
  location?: { file: string; line: number };
}

export interface CallSite {
  file: string;
  line: number;
  expression: string;
  callerSymbolId: string;
  targetSymbolId?: string;
  resolved: boolean;
}

export interface RepositoryAnalysis {
  symbols: SymbolRecord[];
  changedSymbols: ChangedSymbol[];
  changedLines: ChangedLine[];
  uncoveredLines: ChangedLine[];
  calls: CallSite[];
  edges: GraphEdge[];
  diagnostics: AnalysisDiagnostic[];
}

export interface AnalysisDiagnostic {
  side: AnalysisSide;
  file?: string;
  line?: number;
  category: 'error' | 'warning' | 'suggestion' | 'message';
  code: number;
  message: string;
}

export interface AnalyzeRepositoryInput {
  diff: string;
  headFiles: Record<string, string>;
  baseFiles?: Record<string, string>;
  rootDir?: string;
  compilerOptions?: CompilerOptions;
}
