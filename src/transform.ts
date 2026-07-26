import { parse, type AnyNode, type CallExpression, type Node, type Program } from "acorn";
import { ancestor, simple } from "acorn-walk";
import { AgentError } from "./types.js";

export function parseScript(code: string): Program {
  try {
    return parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (err) {
    throw new AgentError("script", `syntax error: ${(err as Error).message}`);
  }
}

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * Where `async` has to go for a function to become async. Method shorthand
 * (`{ foo() {} }`, `class { foo() {} }`) needs it before the key, not before
 * the value's parameter list.
 */
function asyncInsertPoint(fn: Node, parent: Node | undefined): number {
  const p = parent as unknown as { type: string; value?: Node; key?: Node } | undefined;
  if (p && (p.type === "Property" || p.type === "MethodDefinition") && p.value === fn && p.key) {
    return p.key.start;
  }
  return fn.start;
}

const calleeName = (node: CallExpression): string | null =>
  node.callee.type === "Identifier" ? node.callee.name : null;

/**
 * Insert `await` before every bare call to a known step name, and mark the
 * enclosing function `async` when it isn't already — otherwise an awaited step
 * inside a callback like `step('name', () => { … })` is a syntax error.
 */
export function addAwaits(code: string, stepNames: readonly string[]): string {
  const ast = parseScript(code);
  const names = new Set(stepNames);
  const inserts = new Map<number, string>();

  ancestor(ast, {
    CallExpression(node, _state, ancestors) {
      const name = calleeName(node);
      if (!name || !names.has(name)) return;
      const parent = ancestors[ancestors.length - 2];
      if (parent?.type === "AwaitExpression") return;
      inserts.set(node.start, "await ");

      // The nearest enclosing function must be async for that await to be legal.
      for (let i = ancestors.length - 2; i >= 0; i--) {
        const fn = ancestors[i]!;
        if (!FUNCTIONS.has(fn.type)) continue;
        if (!(fn as { async?: boolean }).async) {
          inserts.set(asyncInsertPoint(fn, ancestors[i - 1]), "async ");
        }
        break;
      }
    },
  });

  let out = code;
  for (const at of [...inserts.keys()].sort((a, b) => b - a)) {
    out = out.slice(0, at) + inserts.get(at)! + out.slice(at);
  }
  return out;
}

/** True when the step list produced by collect mode can only be approximate. */
export function hasBranching(code: string): boolean {
  const ast = parseScript(code);
  let found = false;
  const mark = (): void => {
    found = true;
  };
  simple(ast, {
    IfStatement: mark,
    ForStatement: mark,
    ForOfStatement: mark,
    ForInStatement: mark,
    WhileStatement: mark,
    DoWhileStatement: mark,
    SwitchStatement: mark,
    ConditionalExpression: mark,
    LogicalExpression: mark,
  });
  return found;
}

/** Bare calls that are not steps, not locally defined, and not allowed globals. */
export function unknownCalls(
  code: string,
  stepNames: readonly string[],
  allowedGlobals: readonly string[],
): string[] {
  const ast = parseScript(code);
  const known = new Set([...stepNames, ...allowedGlobals]);
  const declared = new Set<string>();
  const called = new Set<string>();

  const declare = (node: AnyNode): void => {
    if (node.type === "FunctionDeclaration" && node.id) declared.add(node.id.name);
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") declared.add(node.id.name);
  };

  simple(ast, {
    FunctionDeclaration: declare,
    VariableDeclarator: declare,
    CallExpression(node) {
      const name = calleeName(node);
      if (name) called.add(name);
    },
  });

  return [...called].filter((name) => !known.has(name) && !declared.has(name));
}
