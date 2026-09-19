import * as path from 'node:path';
import * as ts from 'typescript';
import { parseChangedLines, sideLines } from './diff.js';
import type {
  AnalysisDiagnostic,
  AnalysisSide,
  AnalyzeRepositoryInput,
  CallSite,
  ChangedLine,
  ChangedSymbol,
  GraphEdge,
  RepositoryAnalysis,
  SourceRange,
  SymbolKind,
  SymbolRecord,
} from './types.js';

export function analyzeTypeScriptRepository(input: AnalyzeRepositoryInput): RepositoryAnalysis {
  const rootDir = path.resolve(input.rootDir ?? process.cwd());
  const symbols: SymbolRecord[] = [];
  const calls: CallSite[] = [];
  const edges: GraphEdge[] = [];
  const symbolByNode = new Map<ts.Node, string>();
  const moduleIds = new Map<string, string>();
  const fileSymbols = new Map<string, SymbolRecord[]>();
  const diagnostics: AnalysisDiagnostic[] = [];

  for (const [side, files] of [
    ['base', input.baseFiles] as const,
    ['head', input.headFiles] as const,
  ]) {
    if (!files) continue;
    const { program, host, options } = createProgram(files, rootDir, input.compilerOptions);
    const checker = program.getTypeChecker();
    diagnostics.push(...diagnosticsFor(program, rootDir, side, files));
    const sourceFiles = Object.keys(files)
      .filter((file) => isAnalyzableFile(file, options))
      .map((file) => ({ file, sourceFile: program.getSourceFile(absolutePath(rootDir, file)) }))
      .filter((entry): entry is { file: string; sourceFile: ts.SourceFile } => !!entry.sourceFile);

    for (const { file, sourceFile } of sourceFiles) {
      const module = addSymbols(sourceFile, file, side, checker, symbolByNode);
      moduleIds.set(`${side}:${file}`, module.id);
      fileSymbols.set(`${side}:${file}`, module.symbols);
      symbols.push(...module.symbols);
      edges.push(...module.edges);
    }

    for (const { file, sourceFile } of sourceFiles) {
      const sourceSymbols = fileSymbols.get(`${side}:${file}`) ?? [];
      const moduleId = moduleIds.get(`${side}:${file}`);
      if (!moduleId) continue;
      collectSemanticEdges(
        sourceFile,
        file,
        side,
        checker,
        sourceSymbols,
        moduleId,
        symbolByNode,
        moduleIds,
        rootDir,
        host,
        options,
        edges,
        calls,
      );
    }
  }

  const changedLines = mapChangedLines(input.diff, symbols);
  const changedSymbols = buildChangedSymbols(changedLines, symbols, input.diff);
  markContractChanges(changedSymbols, symbols);

  return {
    symbols,
    changedSymbols,
    changedLines,
    uncoveredLines: changedLines.filter((line) => !line.symbolId),
    calls,
    edges,
    diagnostics,
  };
}

function createProgram(
  files: Record<string, string>,
  rootDir: string,
  compilerOptions: ts.CompilerOptions = {},
): { program: ts.Program; host: ts.CompilerHost; options: ts.CompilerOptions } {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    ...compilerOptions,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options, true);
  const fallbackHost = ts.createCompilerHost(options, true);
  const fileNames = Object.keys(files)
    .filter((file) => isAnalyzableFile(file, options))
    .map((file) => absolutePath(rootDir, file));
  const keyFor = (fileName: string): string => {
    const relative = path.relative(rootDir, fileName);
    return normalize(relative.startsWith('..') ? fileName : relative);
  };
  const read = (fileName: string): string | undefined => files[keyFor(fileName)];
  const allowPhysicalFallback = (fileName: string): boolean => {
    const relative = path.relative(rootDir, fileName);
    return (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      normalize(fileName).includes('/node_modules/')
    );
  };

  host.fileExists = (fileName) =>
    read(fileName) !== undefined ||
    (allowPhysicalFallback(fileName) && ts.sys.fileExists(fileName));
  host.readFile = (fileName) =>
    read(fileName) ?? (allowPhysicalFallback(fileName) ? ts.sys.readFile(fileName) : undefined);
  host.getCurrentDirectory = () => rootDir;
  host.realpath = (fileName) => fileName;
  host.directoryExists = (directory) => {
    const normalized = normalize(path.relative(rootDir, directory));
    const prefix = normalized.length === 0 ? '' : `${normalized}/`;
    return (
      Object.keys(files).some((file) => normalize(file).startsWith(prefix)) ||
      (allowPhysicalFallback(directory) && ts.sys.directoryExists(directory))
    );
  };
  host.getSourceFile = (fileName, languageVersion) => {
    const text = read(fileName);
    return text === undefined
      ? allowPhysicalFallback(fileName)
        ? fallbackHost.getSourceFile(fileName, languageVersion)
        : undefined
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map(
      (moduleName) =>
        ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule,
    );

  return { program: ts.createProgram(fileNames, options, host), host, options };
}

function addSymbols(
  sourceFile: ts.SourceFile,
  file: string,
  side: AnalysisSide,
  checker: ts.TypeChecker,
  symbolByNode: Map<ts.Node, string>,
): { id: string; symbols: SymbolRecord[]; edges: GraphEdge[] } {
  const moduleId = symbolId(side, file, 'module', 'module', sourceFile.getStart(sourceFile));
  const moduleSymbol: SymbolRecord = {
    id: moduleId,
    side,
    file,
    name: 'module',
    kind: 'module',
    comparisonKey: `${file}:module`,
    range: rangeOf(sourceFile, sourceFile),
    exported: false,
    publicContractChanged: false,
  };
  const collected: SymbolRecord[] = [moduleSymbol];
  const edges: GraphEdge[] = [];
  const sourceSymbol = checker.getSymbolAtLocation(sourceFile);
  const exportedNames = new Set(
    sourceSymbol
      ? checker.getExportsOfModule(sourceSymbol).map((exported) => exported.getName())
      : [],
  );

  const siblingOrdinals = new Map<string, number>();
  const visit = (node: ts.Node, parentId: string, parentKey: string): void => {
    const descriptor = descriptorFor(node);
    let nextParent = parentId;
    let nextParentKey = parentKey;
    if (descriptor) {
      const name = descriptor.name;
      const id = symbolId(side, file, descriptor.kind, name, node.getStart(sourceFile));
      const ordinalKey = `${parentKey}:${descriptor.kind}:${name}`;
      const ordinal = siblingOrdinals.get(ordinalKey) ?? 0;
      siblingOrdinals.set(ordinalKey, ordinal + 1);
      const exported = hasExportModifier(node) || exportedNames.has(name);
      const record: SymbolRecord = {
        id,
        side,
        file,
        name,
        kind: descriptor.kind,
        comparisonKey: `${ordinalKey}:${ordinal}`,
        range: rangeOf(sourceFile, node),
        exported,
        publicContractChanged: false,
        typeText: typeText(checker, node),
        ...(parentId === moduleId ? {} : { parentId }),
      };
      collected.push(record);
      symbolByNode.set(node, id);
      nextParent = id;
      nextParentKey = record.comparisonKey;
    }
    ts.forEachChild(node, (child) => visit(child, nextParent, nextParentKey));
  };

  ts.forEachChild(sourceFile, (child) => visit(child, moduleId, moduleSymbol.comparisonKey));
  symbolByNode.set(sourceFile, moduleId);

  for (const record of collected.filter((candidate) => candidate.exported)) {
    edges.push({
      from: moduleId,
      to: record.id,
      type: 'EXPORTS',
      confidence: 1,
      resolver: 'typescript',
    });
  }

  return { id: moduleId, symbols: collected, edges };
}

function collectSemanticEdges(
  sourceFile: ts.SourceFile,
  file: string,
  side: AnalysisSide,
  checker: ts.TypeChecker,
  symbols: SymbolRecord[],
  moduleId: string,
  symbolByNode: Map<ts.Node, string>,
  moduleIds: Map<string, string>,
  rootDir: string,
  host: ts.CompilerHost,
  options: ts.CompilerOptions,
  edges: GraphEdge[],
  calls: CallSite[],
): void {
  const symbolForPosition = (position: number): string => {
    const candidates = symbols.filter((symbol) => containsPosition(symbol, sourceFile, position));
    candidates.sort(compareSymbols);
    return candidates[0]?.id ?? moduleId;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node);
      const declaration = signature?.declaration;
      const targetSymbolId = declaration ? symbolByNode.get(declaration) : undefined;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      calls.push({
        file,
        line,
        expression: node.expression.getText(sourceFile),
        callerSymbolId: symbolForPosition(node.getStart(sourceFile)),
        ...(targetSymbolId ? { targetSymbolId } : {}),
        resolved: !!targetSymbolId,
      });
      if (targetSymbolId) {
        edges.push({
          from: symbolForPosition(node.getStart(sourceFile)),
          to: targetSymbolId,
          type: 'CALLS',
          confidence: 1,
          resolver: 'typescript',
          location: { file, line },
        });
      }
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const resolved = ts.resolveModuleName(
        node.moduleSpecifier.text,
        sourceFile.fileName,
        {
          ...options,
        },
        host,
      ).resolvedModule;
      if (resolved) {
        const targetFile = normalize(path.relative(rootDir, resolved.resolvedFileName));
        const target = moduleIds.get(`${side}:${targetFile}`);
        if (target) {
          edges.push({
            from: moduleId,
            to: target,
            type: 'IMPORTS',
            confidence: 1,
            resolver: 'typescript',
            location: {
              file,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            },
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

function mapChangedLines(diff: string, symbols: SymbolRecord[]): ChangedLine[] {
  const lines: ChangedLine[] = [];
  for (const changes of parseChangedLines(diff)) {
    for (const side of ['head', 'base'] as const) {
      for (const changed of sideLines(changes, side)) {
        const candidates = symbols.filter(
          (symbol) =>
            symbol.side === side &&
            symbol.file === changes.file &&
            symbol.range.startLine <= changed.line &&
            changed.line <= symbol.range.endLine,
        );
        candidates.sort(compareSymbols);
        lines.push({
          file: changes.file,
          side,
          line: changed.line,
          changeType: changed.changeType,
          ...(candidates[0] ? { symbolId: candidates[0].id } : {}),
        });
      }
    }
  }
  return lines;
}

function buildChangedSymbols(
  changedLines: ChangedLine[],
  symbols: SymbolRecord[],
  diff: string,
): ChangedSymbol[] {
  const changes = parseChangedLines(diff);
  const result = new Map<string, ChangedSymbol>();
  for (const line of changedLines) {
    if (!line.symbolId) continue;
    const symbol = symbols.find((candidate) => candidate.id === line.symbolId);
    if (!symbol) continue;
    const fileChange = changes.find((change) => change.file === line.file);
    if (!fileChange) continue;
    const changeType =
      line.side === 'head'
        ? fileChange.deletedLines.length > 0
          ? 'modified'
          : 'added'
        : fileChange.addedLines.length > 0
          ? 'modified'
          : 'deleted';
    const existing = result.get(symbol.id);
    const changedRange = {
      startLine: line.line,
      startColumn: 0,
      endLine: line.line,
      endColumn: 0,
    };
    if (existing) {
      existing.changedRanges.push(changedRange);
      continue;
    }
    result.set(symbol.id, {
      symbolId: symbol.id,
      side: symbol.side,
      file: symbol.file,
      changedRanges: [changedRange],
      changeType,
      exported: symbol.exported,
      publicContractChanged: false,
    });
  }
  return [...result.values()];
}

function markContractChanges(changedSymbols: ChangedSymbol[], symbols: SymbolRecord[]): void {
  const byKey = new Map<string, SymbolRecord>();
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  for (const symbol of symbols) byKey.set(`${symbol.side}:${symbol.comparisonKey}`, symbol);

  for (const changed of changedSymbols) {
    const current = byId.get(changed.symbolId);
    if (!current) continue;
    const otherSide = changed.side === 'head' ? 'base' : 'head';
    const other = byKey.get(`${otherSide}:${current.comparisonKey}`);
    const changedPublicContract =
      current.exported !== other?.exported || current.typeText !== other?.typeText;
    changed.publicContractChanged =
      changedPublicContract && Boolean(current.exported || other?.exported);
    current.publicContractChanged = changed.publicContractChanged;
  }
}

function diagnosticsFor(
  program: ts.Program,
  rootDir: string,
  side: AnalysisSide,
  files: Record<string, string>,
): AnalysisDiagnostic[] {
  const supplied = new Set(Object.keys(files).map(normalize));
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    .filter((diagnostic) => {
      if (!diagnostic.file) return false;
      return supplied.has(normalize(path.relative(rootDir, diagnostic.file.fileName)));
    })
    .map((diagnostic) => {
      const file = diagnostic.file;
      const start = diagnostic.start ?? 0;
      const position = file
        ? file.getLineAndCharacterOfPosition(Math.min(start, file.end))
        : undefined;
      return {
        side,
        ...(file ? { file: normalize(path.relative(rootDir, file.fileName)) } : {}),
        ...(position ? { line: position.line + 1 } : {}),
        category: diagnosticCategory(diagnostic.category),
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      };
    });
}

function diagnosticCategory(category: ts.DiagnosticCategory): AnalysisDiagnostic['category'] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return 'error';
    case ts.DiagnosticCategory.Warning:
      return 'warning';
    case ts.DiagnosticCategory.Suggestion:
      return 'suggestion';
    default:
      return 'message';
  }
}

function descriptorFor(node: ts.Node): { name: string; kind: SymbolKind } | undefined {
  if (ts.isFunctionDeclaration(node)) return named(node, 'function');
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node))
    return named(node, 'method');
  if (ts.isClassDeclaration(node)) return named(node, 'class');
  if (ts.isInterfaceDeclaration(node)) return named(node, 'interface');
  if (ts.isTypeAliasDeclaration(node)) return named(node, 'type');
  if (ts.isEnumDeclaration(node)) return named(node, 'enum');
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return { name: node.name.text, kind: 'variable' };
  }
  return undefined;
}

function named(
  node: { name?: ts.Node },
  kind: SymbolKind,
): { name: string; kind: SymbolKind } | undefined {
  if (!node.name) return undefined;
  return { name: node.name.getText(), kind };
}

function hasExportModifier(node: ts.Node): boolean {
  return !!(ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword ||
      modifier.kind === ts.SyntaxKind.DefaultKeyword,
  );
}

function typeText(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  try {
    return checker.typeToString(checker.getTypeAtLocation(node));
  } catch {
    return undefined;
  }
}

function rangeOf(sourceFile: ts.SourceFile, node: ts.Node): SourceRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.end);
  return {
    startLine: start.line + 1,
    startColumn: start.character,
    endLine: end.line + 1,
    endColumn: end.character,
  };
}

function containsPosition(
  symbol: SymbolRecord,
  sourceFile: ts.SourceFile,
  position: number,
): boolean {
  const start = sourceFile.getPositionOfLineAndCharacter(
    symbol.range.startLine - 1,
    symbol.range.startColumn,
  );
  const end = sourceFile.getPositionOfLineAndCharacter(
    symbol.range.endLine - 1,
    symbol.range.endColumn,
  );
  return start <= position && position <= end;
}

function rangeSize(range: SourceRange): number {
  return (range.endLine - range.startLine) * 10_000 + range.endColumn - range.startColumn;
}

function compareSymbols(a: SymbolRecord, b: SymbolRecord): number {
  return (
    rangeSize(a.range) - rangeSize(b.range) ||
    Number(a.kind === 'module') - Number(b.kind === 'module')
  );
}

function symbolId(
  side: AnalysisSide,
  file: string,
  kind: SymbolKind,
  name: string,
  position: number,
): string {
  return `${side}:${file}:${kind}:${name}:${position}`;
}

function absolutePath(rootDir: string, file: string): string {
  return path.resolve(rootDir, file);
}

function normalize(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isAnalyzableFile(file: string, options: ts.CompilerOptions): boolean {
  if (/\.(tsx?|mts|cts|d\.ts)$/.test(file)) return true;
  return Boolean(options.allowJs) && /\.(jsx?|mjs|cjs)$/.test(file);
}
