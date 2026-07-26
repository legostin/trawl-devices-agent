import { parse } from "acorn";
import { ancestor, simple } from "acorn-walk";
import type { Node } from "acorn";
import { AgentError } from "./types.js";

interface CallNode extends Node {
  callee: { type: string; name?: string };
}

export function parseScript(code: string): Node {
  try {
    return parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as Node;
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
  const p = parent as unknown as { type: string; method?: boolean; value?: Node; key?: Node } | undefined;
  if (p && (p.type === "Property" || p.type === "MethodDefinition") && p.value === fn && p.key) {
    return (p.key as Node).start;
  }
  return fn.start;
}

/**
 * Insert `await` before every bare call to a known step name, and mark the
 * enclosing function `async` when it isn't already — otherwise an awaited step
 * inside a callback like `step('name', () => { … })` is a syntax error.
 */
export function addAwaits(code: string, stepNames: readonly string[]): string {
  const ast = parseScript(code);
  const names = new Set(stepNames);
  const inserts = new Map<number, string>();

  ancestor(ast as never, {
    CallExpression(node: never, _state: unknown, anc: readonly Node[]) {
      const call = node as unknown as CallNode;
      if (call.callee.type !== "Identifier" || !call.callee.name || !names.has(call.callee.name)) return;
      const parent = anc[anc.length - 2];
      if (parent?.type === "AwaitExpression") return;
      inserts.set(call.start, "await ");

      // Nearest enclosing function must be async for that await to be legal.
      for (let i = anc.length - 2; i >= 0; i--) {
        const fn = anc[i]!;
        if (!FUNCTIONS.has(fn.type)) continue;
        if (!(fn as unknown as { async?: boolean }).async) {
          inserts.set(asyncInsertPoint(fn, anc[i - 1]), "async ");
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
  const mark = () => {
    found = true;
  };
  simple(ast as never, {
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

  simple(ast as never, {
    FunctionDeclaration(node: never) {
      const n = node as { id?: { name: string } };
      if (n.id) declared.add(n.id.name);
    },
    VariableDeclarator(node: never) {
      const n = node as { id: { type: string; name?: string } };
      if (n.id.type === "Identifier" && n.id.name) declared.add(n.id.name);
    },
    CallExpression(node: never) {
      const call = node as unknown as CallNode;
      if (call.callee.type === "Identifier" && call.callee.name) called.add(call.callee.name);
    },
  });

  return [...called].filter((name) => !known.has(name) && !declared.has(name));
}
