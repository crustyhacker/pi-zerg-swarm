// Owned parser subprocess. Submitted text is parsed/interpreted as data, NEVER executed.
import ts from 'typescript';
const L = { bytes: 65536, tokens: 8192, literal: 16384, depth: 32, nodes: 12000, astDepth: 64, work: 100000 };
let file, work = 0;
class Rejected extends Error { constructor(message, node) { super(message); this.node = node; } }
function need(ok, message = 'Unsupported workflow script syntax', node) { if (!ok) throw new Rejected(message, node); }
function tick(n = 1) { work += n; need(work <= L.work, 'Compiler work budget exceeded'); }
function span(node) { const start = node.getStart(file), p = file.getLineAndCharacterOfPosition(start); return { start, end: node.end, line: p.line + 1, column: p.character }; }
function preparse(source) {
  need(typeof source === 'string' && source.length <= L.bytes && Buffer.byteLength(source) <= L.bytes && source.isWellFormed(), 'Invalid or oversized UTF-8 source');
  let errors = false, count = 0; const stack = [];
  const scanner = ts.createScanner(ts.ScriptTarget.ESNext, false, ts.LanguageVariant.Standard, source, () => { errors = true; });
  for (let k; (k = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken;) {
    need(!errors, 'Malformed source token');
    if (k >= ts.SyntaxKind.FirstTriviaToken && k <= ts.SyntaxKind.LastTriviaToken) continue;
    need(++count <= L.tokens, 'Source token budget exceeded');
    if ([ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.OpenBracketToken].includes(k)) {
      stack.push(k); need(stack.length <= L.depth, 'Source delimiter depth exceeded');
    } else if ([ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CloseBracketToken].includes(k)) {
      const expected = k === ts.SyntaxKind.CloseBraceToken ? ts.SyntaxKind.OpenBraceToken : k === ts.SyntaxKind.CloseParenToken ? ts.SyntaxKind.OpenParenToken : ts.SyntaxKind.OpenBracketToken;
      need(stack.pop() === expected, 'Unbalanced source delimiters');
    }
    if (k === ts.SyntaxKind.StringLiteral) need(scanner.getTokenValue().length <= L.literal && scanner.getTokenValue().isWellFormed(), 'Invalid or oversized string literal');
    need(![ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.SlashToken, ts.SyntaxKind.SlashEqualsToken].includes(k), 'Templates and regular expressions/operators are unsupported');
  }
  need(!errors && !stack.length, 'Malformed source');
}
const unsafe = k => ['__proto__', 'prototype', 'constructor'].includes(k);
function keys(value, allowed) { need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k)), 'Unknown or invalid workflow field'); }
function stringList(value) { need(Array.isArray(value) && value.every(v => typeof v === 'string'), 'Expected string array'); }
function codingKeys(c) {
  keys(c, ['operation', 'policy', 'checkProfileId']);
  const p = c.policy; keys(p, ['version', 'capabilities', 'identity', 'scope', 'bounds', 'checkProfiles', 'reviewRequired']);
  keys(p.identity, ['parentRunId','workflowRunId','taskId','attemptNo','rootAgentId','workerAgentId','model']);
  need(['parentRunId','taskId','rootAgentId','workerAgentId','model'].every(k => typeof p.identity[k] === 'string'), 'Invalid coding identity');
  need(p.identity.workflowRunId === undefined || typeof p.identity.workflowRunId === 'string', 'Invalid coding workflow identity');
  stringList(p.capabilities);
  need(p.reviewRequired === undefined || typeof p.reviewRequired === 'boolean', 'Invalid review policy');
  keys(p.scope, ['task','writablePaths','protectedPaths','readonlyPaths','baseline','manifest','dependencies']);
  keys(p.scope.baseline, ['projectRootId','stateHash','packageVersion','gitCommit']);
  need(['packageVersion','gitCommit'].every(k => p.scope.baseline[k] === undefined || typeof p.scope.baseline[k] === 'string'), 'Invalid coding baseline');
  stringList(p.scope.writablePaths);
  for (const k of ['protectedPaths','readonlyPaths']) if (p.scope[k] !== undefined) stringList(p.scope[k]);
  for (const list of [p.scope.manifest, p.scope.dependencies ?? []]) { need(Array.isArray(list), 'Invalid coding manifest'); for (const e of list) keys(e, ['path','sha256','bytes','text']); }
  if (p.bounds !== undefined) keys(p.bounds, ['maxFiles','maxFileBytes','maxTotalBytes','maxCandidateBytes','maxOutputBytes','maxCheckMs','maxReviewFindings','maxIterations']);
  if (p.checkProfiles !== undefined) { need(Array.isArray(p.checkProfiles), 'Invalid coding profiles'); for (const e of p.checkProfiles) {
    keys(e, ['id','executable','argv','cwd','env','timeoutMs','profileHash','allowGeneratedOutputs']);
    if (e.env !== undefined) need(e.env && typeof e.env === 'object' && !Array.isArray(e.env) && Object.values(e.env).every(v => typeof v === 'string'), 'Invalid check environment');
  } }
}
function compile(source) {
  work = 0; preparse(source); need(ts.version === '5.9.3', 'Parser version unsupported; migration required');
  const name = '/workflow.workflow.js';
  file = ts.createSourceFile(name, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const options = { allowJs: true, checkJs: false, noLib: true, noResolve: true, noEmit: true, target: ts.ScriptTarget.ESNext };
  // Hermetic public CompilerHost: no ts.sys, filesystem, resolution, config or emit.
  const host = { getSourceFile: n => n === name ? file : undefined, getDefaultLibFileName: () => '', writeFile: () => { throw new Rejected('Emit forbidden'); }, getCurrentDirectory: () => '/', getDirectories: () => [], fileExists: n => n === name, readFile: n => n === name ? source : undefined, getCanonicalFileName: n => n, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n', directoryExists: () => false, resolveModuleNames: names => names.map(() => undefined) };
  const program = ts.createProgram([name], options, host);
  const diagnostics = program.getSyntacticDiagnostics(file);
  if (diagnostics.length) return { ok: false, diagnostics: diagnostics.slice(0, 8).map(d => { const start = d.start ?? 0, p = file.getLineAndCharacterOfPosition(start); return { code: 'syntax', message: 'Invalid JavaScript syntax', span: { start, end: Math.min(source.length, start + (d.length ?? 0)), line: p.line + 1, column: p.character } }; }) };
  const pending = [[file, 0]]; let nodes = 0;
  while (pending.length) { const [n, depth] = pending.pop(); need(++nodes <= L.nodes && depth <= L.astDepth, 'AST complexity exceeded', n); ts.forEachChild(n, child => { pending.push([child, depth + 1]); }); }
  const reserved = new Set(['workflow','native','aggregate','coding','repeat','phase','value','ref']);
  const bindingValues = new WeakSet();
  const sourceSteps = [], phases = [], phaseIds = new Set(), phased = new Set(); let hasCoding = false;
  const clone = v => { tick(); if (Array.isArray(v)) return v.map(clone); if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { tick(k.length); o[k] = clone(x); } return o; } if (typeof v === 'string') tick(v.length); return v; };
  function call(n, name, arity) { need(ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name && !n.questionDotToken && !n.typeArguments && n.arguments.length === arity, 'Invalid builder call', n); return n.arguments; }
  function handle(n, scope) { need(ts.isIdentifier(n) && scope.handles.has(n.text), 'Expected earlier local step handle', n); return scope.handles.get(n.text); }
  function data(n, scope, bindings = false) {
    tick(); need(n, 'Missing expression');
    if (ts.isStringLiteral(n)) { need(n.text.length <= L.literal && n.text.isWellFormed(), 'Invalid literal', n); tick(n.text.length); return n.text; }
    if (ts.isNumericLiteral(n) || (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand))) {
      const raw = n.getText(file); need(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(raw) && Number.isFinite(Number(raw)), 'Only finite decimal literals supported', n); return Number(raw);
    }
    if (n.kind === ts.SyntaxKind.TrueKeyword) return true; if (n.kind === ts.SyntaxKind.FalseKeyword) return false; if (n.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(n)) { need(scope.data.has(n.text), 'Expected earlier data constant (step aliases forbidden)', n); return clone(scope.data.get(n.text)); }
    if (ts.isArrayLiteralExpression(n)) return n.elements.map(e => data(e, scope, bindings));
    if (ts.isObjectLiteralExpression(n)) {
      const o = {};
      for (const p of n.properties) { need(ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)), 'Only explicit plain object properties supported', p); const k = p.name.text; need(!unsafe(k) && !Object.hasOwn(o, k), 'Unsafe or duplicate object key', p); tick(k.length); o[k] = data(p.initializer, scope, bindings); }
      return o;
    }
    if (bindings && ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (n.expression.text === 'value') { const b = { value: data(call(n, 'value', 1)[0], scope) }; bindingValues.add(b); return b; }
      if (n.expression.text === 'ref') {
        const [target, pathNode] = call(n, 'ref', 2);
        need(ts.isArrayLiteralExpression(pathNode) && pathNode.elements.every(ts.isStringLiteral), 'Reference paths require literal string segments', pathNode);
        const path = data(pathNode, scope);
        need(Array.isArray(path) && path.length <= 24 && path.every(p => typeof p === 'string' && !unsafe(p)), 'Invalid literal reference path', n);
        if (ts.isStringLiteral(target)) { need(['inputs','item','iteration'].includes(target.text), 'Invalid reference source', target); const b = { ref: { source: target.text, path } }; bindingValues.add(b); return b; }
        const b = { ref: { source: 'step', stepId: handle(target, scope), path } }; bindingValues.add(b); return b;
      }
    }
    throw new Rejected('Unsupported data expression', n);
  }
  function binding(value) { need(value && bindingValues.has(value), 'Bindings require value() or ref()'); }
  function condition(value) {
    need(value && typeof value === 'object' && !Array.isArray(value), 'Invalid condition');
    if (value.op === 'boolean') binding(value.value);
    else if (['eq','ne','lt','lte','gt','gte'].includes(value.op)) { binding(value.left); binding(value.right); }
    else if (value.op === 'not') condition(value.condition);
    else if (['all','any'].includes(value.op)) { need(Array.isArray(value.conditions), 'Invalid conditions'); value.conditions.forEach(condition); }
    else throw new Rejected('Unknown condition operator');
  }
  function objectNodes(n) { need(ts.isObjectLiteralExpression(n), 'Builder options must be a literal object', n); const o = new Map(); for (const p of n.properties) { need(ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)), 'Expected explicit option', p); const k = p.name.text; need(!unsafe(k) && !o.has(k), 'Unsafe or duplicate option', p); o.set(k, p.initializer); } return o; }
  function identifier(n, scope) { const id = data(n, scope); need(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id), 'Invalid explicit ID', n); return id; }
  function arrow(n) { need(ts.isArrowFunction(n) && !n.modifiers?.length && !n.typeParameters && !n.type && n.parameters.length === 0 && ts.isBlock(n.body), 'Expected zero-argument builder arrow', n); return n.body; }
  function block(n, outer, prefix = []) {
    const scope = { data: new Map(outer?.data), handles: new Map(), names: new Set(outer?.names) }, steps = [], ids = new Set(); let boundary;
    for (const statement of n.statements) {
      tick(); need(!boundary, 'Return must be last statement', statement);
      if (ts.isVariableStatement(statement)) {
        need(!statement.modifiers?.length && (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const && statement.declarationList.declarations.length === 1, 'Only one immutable const declaration supported', statement);
        const d = statement.declarationList.declarations[0]; need(ts.isIdentifier(d.name) && !d.type && !d.exclamationToken && d.initializer, 'Invalid const declaration', d);
        const name = d.name.text; need(!reserved.has(name) && !scope.names.has(name) && !unsafe(name), 'Shadowing or reserved binding forbidden', d); scope.names.add(name);
        const init = d.initializer;
        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && ['native','aggregate','coding','repeat'].includes(init.expression.text)) {
          const kind = init.expression.text, args = call(init, kind, kind === 'repeat' ? 3 : 2), id = identifier(args[0], scope); need(!ids.has(id), 'Duplicate step ID', init); ids.add(id);
          need(sourceSteps.length < 16, 'Authored step budget exceeded', init); const path = [...prefix, id]; sourceSteps.push({ path, span: span(init) });
          const entries = objectNodes(args[1]), opts = {};
          const allowed = kind === 'repeat' ? ['dependsOn','initial','stateSchema','outputSchema','maxIterations','when'] : kind === 'coding' ? ['dependsOn','inputs','outputSchema','coding','when'] : kind === 'native' ? ['dependsOn','inputs','agentId','prompt','outputSchema','fanout','when'] : ['dependsOn','inputs','operation','consumeFailures','consumeSkips','when'];
          for (const [key, expr] of entries) {
            need(allowed.includes(key), 'Unknown builder option', expr);
            if (key === 'dependsOn') { need(ts.isArrayLiteralExpression(expr), 'Dependencies require literal handle array', expr); opts[key] = expr.elements.map(e => handle(e, scope)); }
            else opts[key] = data(expr, scope, ['inputs','initial','when','fanout'].includes(key));
          }
          if (opts.inputs !== undefined) { need(opts.inputs && typeof opts.inputs === 'object' && !Array.isArray(opts.inputs), 'Invalid inputs'); Object.values(opts.inputs).forEach(binding); }
          if (opts.initial !== undefined) binding(opts.initial);
          if (opts.when !== undefined) condition(opts.when);
          if (!entries.has('dependsOn')) opts.dependsOn = [];
          if (opts.fanout) { keys(opts.fanout, ['from','maxItems']); binding(opts.fanout.from); keys(opts.fanout.from, ['ref']); need(opts.fanout.from.ref, 'Fanout requires ref()', init); opts.fanout.from = opts.fanout.from.ref; }
          if (kind === 'coding') { codingKeys(opts.coding); hasCoding = true; }
          if (kind === 'repeat') { need(!prefix.length, 'Nested repeats forbidden', init); const body = block(arrow(args[2]), scope, path); need(body.boundary, 'Repeat requires terminal boundary return', init); Object.assign(opts, { body: body.steps }, body.boundary); }
          steps.push({ id, kind, ...opts }); scope.handles.set(name, id);
        } else scope.data.set(name, data(init, scope));
      } else if (ts.isExpressionStatement(statement)) {
        const args = call(statement.expression, 'phase', 2), id = identifier(args[0], scope); need(!phaseIds.has(id) && phases.length < 16, 'Duplicate or excessive phase ID', statement); phaseIds.add(id);
        need(ts.isArrayLiteralExpression(args[1]) && args[1].elements.length > 0, 'Phase requires local handles', statement);
        const paths = args[1].elements.map(e => { const path = [...prefix, handle(e, scope)], key = JSON.stringify(path); need(!phased.has(key), 'Step belongs to more than one phase', e); phased.add(key); return path; }); phases.push({ id, paths, span: span(statement.expression) });
      } else if (ts.isReturnStatement(statement) && prefix.length) { need(statement.expression, 'Missing repeat boundary', statement); boundary = data(statement.expression, scope, true); keys(boundary, ['feedback','until','output']); need(Object.keys(boundary).length === 3, 'Incomplete repeat boundary', statement); binding(boundary.feedback); binding(boundary.output); condition(boundary.until); }
      else throw new Rejected('Unsupported builder statement', statement);
    }
    return { steps, boundary };
  }
  need(file.statements.length === 1 && ts.isExpressionStatement(file.statements[0]), 'Expected exactly one workflow declaration', file);
  const [meta, builder] = call(file.statements[0].expression, 'workflow', 2), metadata = data(meta, { data: new Map() }); keys(metadata, ['id','label','inputSchema']);
  const result = block(arrow(builder));
  const definition = { ...metadata, version: hasCoding ? 3 : 2, steps: result.steps };
  const reply = { ok: true, definition, steps: sourceSteps, phases };
  need(Buffer.byteLength(JSON.stringify(reply)) <= 65536, 'Compiler output budget exceeded'); return reply;
}
let bytes = 0, chunks = [];
process.stdin.on('data', chunk => { bytes += chunk.length; if (bytes > 6 * L.bytes + 13) { process.exitCode = 1; process.stdin.destroy(); } else chunks.push(chunk); });
process.stdin.on('end', () => {
  let reply;
  try { const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); keys(request, ['source']); reply = compile(request.source); }
  catch (error) { reply = { ok: false, diagnostics: [{ code: 'rejected', message: error instanceof Rejected ? error.message.slice(0, 256) : 'Compiler rejected source', ...(error instanceof Rejected && error.node && file ? { span: span(error.node) } : {}) }] }; }
  process.stdout.write(JSON.stringify(reply));
});
