import type { CallExpression, Expression, ExpressionStatement, Node, Program } from "acorn";
import { parseScript } from "./transform.js";
import { STEP_NAMES } from "./steps.js";

export interface RowArg {
  /** The literal value, or the source text when it is an expression. */
  value: unknown;
  /** False when the argument is an expression the pickers must not touch. */
  literal: boolean;
  range: [number, number];
}

export interface Row {
  /** Stable within one parse; the plugin addresses rows by it. */
  id: string;
  kind: "step" | "code";
  action?: string;
  args: RowArg[];
  /** The enclosing step('…') block, when there is one. */
  section?: string;
  disabled: boolean;
  /** 1-based, for the editor and for error messages. */
  line: number;
  range: [number, number];
  raw: string;
}

const STEPS = new Set<string>(STEP_NAMES);

const lineOf = (code: string, at: number): number => code.slice(0, at).split("\n").length;

const literalOf = (node: Expression): { value: unknown; literal: boolean } =>
  node.type === "Literal" ? { value: node.value, literal: true } : { value: undefined, literal: false };

const callOf = (statement: Node): CallExpression | null => {
  if (statement.type !== "ExpressionStatement") return null;
  const expression = (statement as ExpressionStatement).expression;
  if (expression.type === "AwaitExpression") {
    return expression.argument.type === "CallExpression" ? expression.argument : null;
  }
  return expression.type === "CallExpression" ? expression : null;
};

const stepName = (call: CallExpression): string | null =>
  call.callee.type === "Identifier" && STEPS.has(call.callee.name) ? call.callee.name : null;

/** `step('name', () => { … })` — the only nesting the row model understands. */
const sectionOf = (call: CallExpression): { name: string; body: Node[] } | null => {
  if (stepName(call) !== "step") return null;
  const [first, second] = call.arguments;
  if (first?.type !== "Literal" || typeof first.value !== "string") return null;
  if (!second || (second.type !== "ArrowFunctionExpression" && second.type !== "FunctionExpression")) return null;
  if (second.body.type !== "BlockStatement") return null;
  return { name: first.value, body: second.body.body };
};

/**
 * A step that a human commented out. Losing it on the way into the editor would
 * turn "disabled" into "deleted", which is not what anyone meant by `//`.
 */
const DISABLED_LINE = new RegExp(`^(\\s*)//\\s*(${[...STEPS].join("|")})\\s*\\(`);

export function toRows(code: string): Row[] {
  const ast: Program = parseScript(code);
  const rows: Row[] = [];
  let seen = 0;

  const push = (node: Node, kind: Row["kind"], extra: Partial<Row>): void => {
    rows.push({
      id: `r${seen++}`,
      kind,
      args: [],
      disabled: false,
      line: lineOf(code, node.start),
      range: [node.start, node.end],
      raw: code.slice(node.start, node.end),
      ...extra,
    });
  };

  // Program.body admits module declarations that a "script" parse can never
  // produce; anything not a flat step call becomes a code row anyway.
  const walk = (statements: readonly Node[], section?: string): void => {
    for (const statement of statements) {
      const call = callOf(statement);
      const nested = call ? sectionOf(call) : null;

      // One level only: a section inside a section is not something the visual
      // modes can lay out honestly, so it stays code.
      if (nested && section === undefined) {
        walk(nested.body, nested.name);
        continue;
      }

      const name = call && !nested ? stepName(call) : null;
      if (name) {
        push(statement, "step", {
          action: name,
          section,
          args: call!.arguments.map((argument) => ({
            ...literalOf(argument as Expression),
            ...(argument.type === "Literal" ? {} : { value: code.slice(argument.start, argument.end) }),
            range: [argument.start, argument.end] as [number, number],
          })),
        });
        continue;
      }

      push(statement, "code", { section });
    }
  };

  walk(ast.body);

  // Commented-out steps are invisible to the parser, so they are spliced back in
  // by line, in the order they appear in the file.
  const disabled: Row[] = [];
  let offset = 0;
  for (const [index, text] of code.split("\n").entries()) {
    const hit = DISABLED_LINE.exec(text);
    if (hit) {
      const indent = hit[1]?.length ?? 0;
      disabled.push({
        id: `d${index}`,
        kind: "step",
        action: hit[2],
        args: [],
        disabled: true,
        line: index + 1,
        range: [offset + indent, offset + text.length],
        raw: text.trim(),
      });
    }
    offset += text.length + 1;
  }

  return [...rows, ...disabled].sort((a, b) => a.line - b.line);
}
