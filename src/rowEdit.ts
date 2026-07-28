import { AgentError } from "./types.js";
import { formatArg } from "./codegen.js";
import { toRows, type Row } from "./rows.js";

export type Command =
  | { kind: "remove"; id: string }
  | { kind: "setDisabled"; id: string; disabled: boolean }
  | { kind: "move"; id: string; before: string | null }
  | { kind: "setArg"; id: string; index: number; value: unknown }
  | { kind: "insert"; before: string | null; action: string; args: unknown[]; section?: string };

const find = (rows: Row[], id: string): Row => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new AgentError("script", `строка ${id} не найдена — сценарий изменился, обновите его`);
  return row;
};

/** The whole lines a row occupies, so removing it does not leave a blank one. */
const lineSpan = (code: string, row: Row): [number, number] => {
  const start = code.lastIndexOf("\n", row.range[0] - 1) + 1;
  const end = code.indexOf("\n", row.range[1] - 1);
  return [start, end < 0 ? code.length : end + 1];
};

const indentOf = (code: string, row: Row): string => {
  const [start] = lineSpan(code, row);
  return code.slice(start, row.range[0]).match(/^[ \t]*/)?.[0] ?? "";
};

const splice = (code: string, [start, end]: [number, number], text: string): string =>
  code.slice(0, start) + text + code.slice(end);

const stepLine = (action: string, args: unknown[]): string => `${action}(${args.map(formatArg).join(", ")})`;

/**
 * Every command rewrites source text by range. A model that re-printed the file
 * would reformat lines nobody touched, and a scenario is a file a human reads in
 * a diff.
 */
export function applyCommand(code: string, command: Command): string {
  const rows = toRows(code);

  if (command.kind === "insert") {
    const line = stepLine(command.action, command.args);
    if (command.before === null) {
      const body = code === "" || code.endsWith("\n") ? code : `${code}\n`;
      return `${body}${line}\n`;
    }
    const anchor = find(rows, command.before);
    const [start] = lineSpan(code, anchor);
    return splice(code, [start, start], `${indentOf(code, anchor)}${line}\n`);
  }

  const row = find(rows, command.id);

  if (command.kind === "remove") return splice(code, lineSpan(code, row), "");

  if (command.kind === "setDisabled") {
    const [start, end] = lineSpan(code, row);
    const text = code.slice(start, end);
    const next = command.disabled
      ? text.replace(/^([ \t]*)/, "$1// ")
      : text.replace(/^([ \t]*)\/\/\s?/, "$1");
    return splice(code, [start, end], next);
  }

  if (command.kind === "setArg") {
    const argument = row.args[command.index];
    if (!argument) throw new AgentError("script", `у шага ${row.action} нет аргумента ${command.index}`);
    if (!argument.literal) {
      throw new AgentError(
        "script",
        `аргумент ${command.index} шага ${row.action} — выражение, его правят в коде`,
      );
    }
    return splice(code, argument.range, formatArg(command.value));
  }

  // move: cut the line out, then put it back with the target's indentation.
  const span = lineSpan(code, row);
  const text = code.slice(span[0], span[1]).replace(/^[ \t]*/, "").replace(/\n$/, "");
  const without = splice(code, span, "");
  if (command.before === null) return `${without.endsWith("\n") ? without : `${without}\n`}${text}\n`;

  // The anchor is resolved against the original parse and then shifted: row ids
  // come from position, so re-finding it in the shortened source would land on
  // whatever moved up into its place.
  const anchor = find(rows, command.before);
  const [anchorStart] = lineSpan(code, anchor);
  const indent = indentOf(code, anchor);
  const at = anchorStart > span[0] ? anchorStart - (span[1] - span[0]) : anchorStart;
  return splice(without, [at, at], `${indent}${text}\n`);
}
